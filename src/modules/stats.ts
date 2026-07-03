// Ported from module_stats.lua — tracks daily per-guild activity stats
// (messages, reactions, member joins/leaves) and can print/export them.
//
// Two persistence tracks are involved, exactly like the lua original:
//   - The *current* day's running counters live in the module's standard
//     persistent data (`this.getPersistentData(guild).Stats`), auto-saved by
//     the framework like any other module.
//   - Finalized days are archived as flat JSON files under
//     `stats/guild_<id>/stats_YYYY-MM-DD.json` (a folder layout independent
//     from the `data/module_stats/...` persistence tree), written by
//     `saveStats`/read back by `loadStats`/`serverstats`.
//
// The lua module also ran a tiny raw HTTP server (coro-net + http-codec) for
// external dashboards to pull stats. There's no equivalent helper in the
// TypeScript framework (this is a bot-internal, non-Discord concern), so it
// is re-implemented here with Node's built-in `http` module as a local,
// self-contained workaround — see the "HTTP API server" section below.

import * as http from "http";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";
import { osTime, formatTime } from "../util/time";
import { scanDir, serializeToFile, unserializeFromFile } from "../core/storage";
import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from "discord.js";

// --- Stats data shape (mirrors the plain lua tables serialized to JSON) -----

interface ChannelStat {
  MessageCount: number;
  ReactionCount: number;
}
interface ReactionStat {
  ReactionCount: number;
}
interface UserStat {
  MessageCount: number;
  ReactionCount: number;
}

interface StatsData {
  Date: number;
  Channels: Record<string, ChannelStat>;
  Reactions: Record<string, ReactionStat>;
  Users: Record<string, UserStat>;
  MemberCount?: number;
  MemberCountHistory?: number[];
  MemberLeft: number;
  MemberJoined: number;
  MessageCount: number;
  ReactionAdded: number;
  ReactionRemoved: number;
}

interface DateParts {
  d: string;
  m: string;
  y: string;
}

// --- Free helper functions (ported 1:1 from the lua locals) ----------------

function numcmp(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareDates(day1: string, month1: string, year1: string, day2: string, month2: string, year2: string): number {
  if (year1 === year2) {
    if (month1 === month2) return numcmp(day1, day2);
    return numcmp(month1, month2);
  }
  return numcmp(year1, year2);
}

function compareDateParts(a: DateParts, b: DateParts): number {
  return compareDates(a.d, a.m, a.y, b.d, b.m, b.y);
}

/** Port of lua's `table.binsearch`: exact index on a hit, else the lower-bound insertion index. */
function binsearchIndex<T>(arr: T[], value: T, comp: (a: T, b: T) => number): number {
  let iStart = 0;
  let iEnd = arr.length - 1;
  while (iStart <= iEnd) {
    const iMid = Math.floor((iStart + iEnd) / 2);
    const r = comp(value, arr[iMid]);
    if (r === 0) return iMid;
    else if (r < 0) iEnd = iMid - 1;
    else iStart = iMid + 1;
  }
  return iStart;
}

function accumulateArray(dstArray: Record<string, any>, srcArray: Record<string, any>): void {
  for (const [k, v] of Object.entries(srcArray)) {
    if (typeof v === "number") {
      const refValue = dstArray[k];
      dstArray[k] = refValue === undefined ? v : refValue + v;
    } else if (v && typeof v === "object") {
      let refValue = dstArray[k];
      if (refValue === undefined) {
        refValue = {};
        dstArray[k] = refValue;
      }
      accumulateArray(refValue, v);
    }
  }
}

function accumulateStats(stats: StatsData, dateStats: StatsData): void {
  stats.MemberLeft += dateStats.MemberLeft;
  stats.MemberJoined += dateStats.MemberJoined;
  stats.MessageCount += dateStats.MessageCount;
  stats.ReactionAdded += dateStats.ReactionAdded;
  stats.ReactionRemoved += dateStats.ReactionRemoved;
  stats.MemberCount = dateStats.MemberCount;
  stats.MemberCountHistory!.push(dateStats.MemberCount ?? 0);

  accumulateArray(stats.Channels, dateStats.Channels);
  accumulateArray(stats.Reactions, dateStats.Reactions);
  accumulateArray(stats.Users, dateStats.Users);
}

// --- Tiny HTTP API response helpers (ported from the lua Ok/NotFound/...) --

interface ApiResponse {
  code: number;
  reason?: string;
  contentType: string;
  body: string;
}

// NOTE: the lua `BadRequest` helper actually builds a 404 "Not Found" header
// (looks like a copy/paste from `NotFound`) instead of a 400. That quirk is
// kept here on purpose for behavioral fidelity.
function apiBadRequest(body = ""): ApiResponse {
  return { code: 404, reason: "Not Found", contentType: "charset=utf-8", body };
}
function apiUnauthorized(body = ""): ApiResponse {
  return { code: 401, contentType: "charset=utf-8", body };
}
function apiOk(body = "", contentType = "charset=utf-8"): ApiResponse {
  return { code: 200, reason: "OK", contentType, body };
}
function apiNotFound(body = ""): ApiResponse {
  return { code: 404, reason: "Not Found", contentType: "charset=utf-8", body };
}
function apiServerErrorResponse(body = ""): ApiResponse {
  return { code: 500, contentType: "charset=utf-8", body };
}

export default class StatsModule extends BotModule {
  name = "stats";

  private server?: http.Server;
  private dayTimer?: Timer;

  // --- Config ----------------------------------------------------------------

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "LogChannel",
        Description: "Channel where stats will be posted each day",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "ShowActiveUsers",
        Description: "Allows most active users stats to be shown",
        Type: ConfigType.Boolean,
        Default: false,
      },
      {
        Name: "AllowAPIAccess",
        Description: "Allows to access this server stats via the web API",
        Type: ConfigType.Boolean,
        Default: false,
      },
      {
        Name: "APIPrivateKey",
        Description: "Private key required to access stats via the web API (empty to allow public access)",
        Type: ConfigType.String,
        Optional: true,
        Sensitive: true,
      },
      {
        Global: true,
        Name: "ListenPort",
        Description: "Port on which internal server listens",
        Type: ConfigType.Integer,
        Default: 14794,
      },
    ];
  }

  // --- Lifecycle ---------------------------------------------------------------

  async onLoaded(): Promise<boolean> {
    this.server = await this.setupServer();
    if (!this.server) {
      this.logError(null, "Failed to start stats server");
    }

    this.registerCommand({
      Name: "resetstats",
      Args: [],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Resets stats of the day",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const data = this.getPersistentData(guild)!;
        data.Stats = this.buildStats(guild);
        await ctx.reply("Stats reset successfully");
      },
    });

    this.registerCommand({
      Name: "serverstats",
      Args: [
        { Name: "date/from", Type: ConfigType.String, Optional: true, Description: "Date (YYYY-MM-DD), or start of a range" },
        { Name: "to", Type: ConfigType.String, Optional: true, Description: "End of the range (YYYY-MM-DD)" },
      ],
      Help: "Prints stats",
      Func: async (ctx, from?: string, to?: string) => {
        await this.handleServerStatsCommand(ctx, from, to);
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const data = this.getPersistentData(guild)!;
    if (!data.Stats) {
      this.logInfo(guild, "No previous stats found, resetting...");
      data.Stats = this.buildStats(guild);
    } else {
      const currentDate = this.formatDateISO(osTime());
      const statsDate = this.formatDateISO(data.Stats.Date);
      if (currentDate !== statsDate) {
        this.logInfo(guild, "Previous stats data has been found but date does not match (%s), saving and resetting", statsDate);
        await this.saveStats(this.getStatsFilename(guild, data.Stats.Date), data.Stats);
        data.Stats = this.buildStats(guild);
      } else {
        this.logInfo(guild, "Previous stats data has been found and date does match, continuing...");
      }
    }

    return true;
  }

  async onReady(): Promise<void> {
    this.scheduleNextDayRollover();
  }

  async onUnload(): Promise<void> {
    this.dayTimer?.stop();
    this.server?.close();
  }

  // --- `!serverstats` command implementation ----------------------------------

  private async handleServerStatsCommand(ctx: any, from?: string, to?: string): Promise<void> {
    const guild = ctx.guild!;

    if (from && to && from !== to) {
      const fromMatch = from.match(/^(\d\d\d\d)-(\d\d)-(\d\d)$/);
      if (!fromMatch) {
        await ctx.reply("Invalid date format for `from` parameter, please write it as YYYY-MM-DD");
        return;
      }
      const [, fromY, fromM, fromD] = fromMatch;

      const toMatch = to.match(/^(\d\d\d\d)-(\d\d)-(\d\d)$/);
      if (!toMatch) {
        await ctx.reply("Invalid date format for `to` parameter, please write it as YYYY-MM-DD");
        return;
      }
      const [, toY, toM, toD] = toMatch;

      if (compareDates(fromD, fromM, fromY, toD, toM, toY) >= 0) {
        await ctx.reply("`from` date must be earlier than `to` date");
        return;
      }

      await (ctx.channel as any)?.sendTyping?.().catch(() => {});

      // Check available dates
      const guildStatsFolder = this.getStatsFolder(guild);

      const availableStats: DateParts[] = [];
      for (const entry of await scanDir(guildStatsFolder)) {
        if (entry.isDirectory) continue;
        const m = entry.name.match(/^stats_(\d\d\d\d)-(\d\d)-(\d\d)\.json$/);
        if (m) availableStats.push({ y: m[1], m: m[2], d: m[3] });
      }

      if (availableStats.length === 0) {
        await ctx.reply("We have no stats for that date range");
        return;
      }

      availableStats.sort(compareDateParts);

      let fromDate: DateParts = { d: fromD, m: fromM, y: fromY };
      if (compareDateParts(fromDate, availableStats[0]) < 0) {
        fromDate = availableStats[0];
      }

      let toDate: DateParts = { d: toD, m: toM, y: toY };
      if (compareDateParts(toDate, availableStats[availableStats.length - 1]) > 0) {
        toDate = availableStats[availableStats.length - 1];
      }

      const firstIndex = binsearchIndex(availableStats, fromDate, compareDateParts);
      const lastIndex = binsearchIndex(availableStats, toDate, compareDateParts);

      const accumulatedStats = this.buildStats(guild);
      delete accumulatedStats.MemberCount;
      accumulatedStats.MemberCountHistory = [];

      for (let i = firstIndex; i <= lastIndex; i++) {
        const v = availableStats[i];
        const fileName = `${guildStatsFolder}/stats_${v.y}-${v.m}-${v.d}.json`;
        const stats = await this.loadStats(guild, fileName);
        if (!stats) {
          await ctx.reply("Failed to load some stats");
          return;
        }

        accumulateStats(accumulatedStats, stats);
      }

      await this.printStats(
        ctx.channel,
        accumulatedStats,
        `${fromDate.d}-${fromDate.m}-${fromDate.y}`,
        `${toDate.d}-${toDate.m}-${toDate.y}`,
        lastIndex - firstIndex + 1,
      );
    } else if (from) {
      if (!from.match(/^\d\d\d\d-\d\d-\d\d$/)) {
        await ctx.reply("Invalid date format, please write it as YYYY-MM-DD");
        return;
      }

      const stats = await this.loadStats(guild, this.getStatsFilename(guild, from));
      if (!stats) {
        await ctx.reply("We have no stats for that date");
        return;
      }

      await this.printStats(ctx.channel, stats);
    } else {
      const data = this.getPersistentData(guild)!;
      await this.printStats(ctx.channel, data.Stats);
    }
  }

  // --- Day rollover (ported from the lua `discordia.Clock` "day" listener) ---

  private scheduleNextDayRollover(): void {
    const next = this.getNextMidnightTimestamp();
    this.dayTimer = this.bot.scheduleTimer(next, async () => {
      await this.handleDayRollover();
      this.scheduleNextDayRollover();
    });
  }

  private getNextMidnightTimestamp(): number {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.floor(next.getTime() / 1000);
  }

  private async handleDayRollover(): Promise<void> {
    const targets: { config: Record<string, any>; persistentData: Record<string, any>; guild: Guild }[] = [];
    this.forEachGuild((_guildId, config, _data, persistentData, guild) => {
      if (guild) targets.push({ config, persistentData, guild });
    });

    for (const { config, persistentData, guild } of targets) {
      const stats: StatsData = persistentData.Stats;
      await this.saveStats(this.getStatsFilename(guild, stats.Date), stats);
      persistentData.Stats = this.buildStats(guild);

      if (config.LogChannel) {
        const channel = guild.channels.cache.get(config.LogChannel);
        if (channel && channel.isTextBased()) {
          // Fire-and-forget, mirroring the lua `coroutine.wrap(...)()` detached call.
          this.printStats(channel as any, stats).catch((e: any) =>
            this.logWarning(guild, "Failed to print daily stats: %s", e?.message ?? e),
          );
        }
      }
    }
  }

  // --- Stats storage helpers ---------------------------------------------------

  private async loadStats(guild: Guild | null, filepath: string): Promise<StatsData | undefined> {
    const [stats, err] = await unserializeFromFile<StatsData>(filepath);
    if (!stats) {
      this.logError(guild, "Failed to load stats: %s", err);
      return undefined;
    }
    return stats;
  }

  private async saveStats(filename: string, stats: StatsData): Promise<void> {
    const [ok, err] = await serializeToFile(filename, stats);
    if (!ok) {
      this.logError(null, "Failed to save stats %s: %s", filename, err);
    }
  }

  private getStatsFilename(guild: Guild, time: number | string): string {
    const dateStr = typeof time === "number" ? this.formatDateISO(time) : time;
    return `${this.getStatsFolder(guild)}/stats_${dateStr}.json`;
  }

  private getStatsFolder(guild: Guild): string {
    return `stats/guild_${guild.id}`;
  }

  private buildStats(guild: Guild): StatsData {
    return {
      Date: osTime(),
      Channels: {},
      Reactions: {},
      Users: {},
      MemberCount: guild.memberCount,
      MemberLeft: 0,
      MemberJoined: 0,
      MessageCount: 0,
      ReactionAdded: 0,
      ReactionRemoved: 0,
    };
  }

  private formatDateISO(timestamp: number): string {
    const d = new Date(timestamp * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  private formatDateDMY(timestamp: number): string {
    const d = new Date(timestamp * 1000);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // --- Per-guild counters (lazily created dictionaries) -----------------------

  private getChannelStats(guild: Guild, channel: { id: string; isThread?: () => boolean; parentId?: string | null }): ChannelStat {
    const channelId = channel.isThread?.() ? channel.parentId : channel.id;
    if (typeof channelId !== "string") {
      this.logError(null, "expected string as channel id, got " + typeof channelId);
      return { MessageCount: 0, ReactionCount: 0 };
    }

    const data = this.getPersistentData(guild)!;
    const channels: Record<string, ChannelStat> = data.Stats.Channels;
    let channelStats = channels[channelId];
    if (!channelStats) {
      channelStats = { MessageCount: 0, ReactionCount: 0 };
      channels[channelId] = channelStats;
    }
    return channelStats;
  }

  private getReactionStats(guild: Guild, reactionName: unknown): ReactionStat {
    if (typeof reactionName !== "string") {
      this.logError(null, "expected string as reaction name, got " + typeof reactionName);
      return { ReactionCount: 0 };
    }

    const data = this.getPersistentData(guild)!;
    const reactions: Record<string, ReactionStat> = data.Stats.Reactions;
    let reactionStats = reactions[reactionName];
    if (!reactionStats) {
      reactionStats = { ReactionCount: 0 };
      reactions[reactionName] = reactionStats;
    }
    return reactionStats;
  }

  private getUserStats(guild: Guild, userId: unknown): UserStat {
    if (typeof userId !== "string") {
      this.logError(null, "expected string as user id, got " + typeof userId);
      return { MessageCount: 0, ReactionCount: 0 };
    }

    const data = this.getPersistentData(guild)!;
    const users: Record<string, UserStat> = data.Stats.Users;
    let userStats = users[userId];
    if (!userStats) {
      userStats = { MessageCount: 0, ReactionCount: 0 };
      users[userId] = userStats;
    }
    return userStats;
  }

  // --- Printing -----------------------------------------------------------------

  private async printStats(channel: any, stats: StatsData, fromDate?: string, toDate?: string, dayCount?: number): Promise<void> {
    const guild: Guild = channel.guild;
    const config = this.getConfig(guild)!;

    let memberCount: string | undefined;
    let valueFunc: (value: number | undefined, msg?: string | number) => string;

    if (dayCount) {
      const memberCountHistory = stats.MemberCountHistory ?? [];
      if (memberCountHistory.length > 0) {
        const firstMemberCount = memberCountHistory[0];
        const lastMemberCount = memberCountHistory[memberCountHistory.length - 1];
        if (lastMemberCount > firstMemberCount) {
          memberCount = `${lastMemberCount} (+ ${lastMemberCount - firstMemberCount})`;
        } else if (lastMemberCount < firstMemberCount) {
          memberCount = `${lastMemberCount} (- ${firstMemberCount - lastMemberCount})`;
        } else {
          memberCount = `${lastMemberCount} (=)`;
        }
      }

      const dc = dayCount;
      valueFunc = (value, msg) => {
        if (value !== undefined && value !== null) {
          return `${value} (${Math.floor(value / dc)} avg.)`;
        }
        return String(msg ?? 0);
      };
    } else {
      valueFunc = (value, msg) => {
        if (value !== undefined && value !== null) {
          return String(value);
        }
        return String(msg ?? 0);
      };
    }

    if (memberCount === undefined) {
      memberCount = String(stats.MemberCount ?? "<No logs>");
    }

    // Most added reactions (top 5)
    const mostAddedReaction = Object.entries(stats.Reactions ?? {}).map(([name, s]) => ({ name, count: s.ReactionCount }));
    mostAddedReaction.sort((a, b) => b.count - a.count);

    let addedReactionList = "";
    for (let i = 0; i < Math.min(5, mostAddedReaction.length); i++) {
      const reactionData = mostAddedReaction[i];
      const emojiData = this.bot.getEmojiData(guild, reactionData.name);
      if (!emojiData) {
        this.logError(null, "Most added reaction %s is not found", reactionData.name);
      }
      addedReactionList += `${valueFunc(reactionData.count)} ${emojiData ? emojiData.mentionString : `<bot error on ${reactionData.name}>`}\n`;
    }

    // Most active channels (top 5)
    const mostActiveChannels = Object.entries(stats.Channels ?? {}).map(([id, s]) => ({ id, messageCount: s.MessageCount }));
    mostActiveChannels.sort((a, b) => b.messageCount - a.messageCount);

    let activeChannelList = "";
    for (let i = 0; i < Math.min(5, mostActiveChannels.length); i++) {
      const channelData = mostActiveChannels[i];
      const ch = guild.channels.cache.get(channelData.id);
      const chLabel = ch ? `[#${(ch as any).name}](https://discord.com/channels/${guild.id}/${ch.id})` : "<deleted channel>";
      activeChannelList += `${chLabel}: ${valueFunc(channelData.messageCount)} m.\n`;
    }

    // Most active members (top 5, opt-in)
    let activeMemberList: string | undefined;
    if (config.ShowActiveUsers) {
      const mostActiveMembers = Object.entries(stats.Users ?? {}).map(([id, s]) => ({ id, messageCount: s.MessageCount }));
      mostActiveMembers.sort((a, b) => b.messageCount - a.messageCount);

      activeMemberList = "";
      for (let i = 0; i < Math.min(5, mostActiveMembers.length); i++) {
        const memberData = mostActiveMembers[i];
        activeMemberList += `<@${memberData.id}>: ${valueFunc(memberData.messageCount)} m.\n`;
      }
    }

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: "Member count", value: memberCount, inline: true },
      { name: "New members", value: valueFunc(stats.MemberJoined), inline: true },
      { name: "Lost members", value: valueFunc(stats.MemberLeft), inline: true },
      { name: "Messages posted", value: valueFunc(stats.MessageCount), inline: true },
      { name: "Active members", value: String(Object.keys(stats.Users ?? {}).length), inline: true },
      { name: "Active channels", value: String(Object.keys(stats.Channels ?? {}).length), inline: true },
      { name: "Total reactions added", value: valueFunc(stats.ReactionAdded), inline: true },
      { name: "Most added reactions", value: addedReactionList.length > 0 ? addedReactionList : "<None>", inline: true },
      { name: "Most active channels", value: activeChannelList.length > 0 ? activeChannelList : "<None>", inline: true },
    ];

    if (activeMemberList !== undefined) {
      fields.push({ name: "Most active members", value: activeMemberList.length > 0 ? activeMemberList : "<None>", inline: true });
    }

    let title: string;
    if (!fromDate) {
      const resetTime = osTime() - stats.Date;
      title = `Server stats - ${this.formatDateDMY(stats.Date)}, started ${formatTime(resetTime, 2)} ago`;
    } else {
      title = `Server stats - from ${fromDate} to ${toDate}`;
    }

    await channel.send({
      embeds: [
        {
          title,
          fields,
          timestamp: new Date(stats.Date * 1000).toISOString(),
        },
      ],
    });
  }

  // --- HTTP API server (local re-implementation, see file header) ------------

  private async setupServer(): Promise<http.Server | undefined> {
    const port = this.globalConfig.ListenPort;
    if (!port || port <= 0) {
      return undefined;
    }

    const server = http.createServer((req, res) => {
      this.handleApiRequest(req)
        .then((response) => this.writeApiResponse(res, response))
        .catch(() => {
          this.logWarning(null, "Stats API: Server error");
          this.writeApiResponse(res, apiServerErrorResponse());
        });
    });

    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });

    return bound ? server : undefined;
  }

  private writeApiResponse(res: http.ServerResponse, response: ApiResponse): void {
    const headers = { "Content-Type": response.contentType };
    if (response.reason) {
      res.writeHead(response.code, response.reason, headers);
    } else {
      res.writeHead(response.code, headers);
    }
    res.end(response.body);
  }

  private async handleApiRequest(req: http.IncomingMessage): Promise<ApiResponse> {
    if (req.method !== "GET" || !req.url) {
      return apiNotFound();
    }

    const pathname = req.url.split("?")[0];

    if (/^\/servers$/.test(pathname)) {
      return this.apiServerList();
    }

    const m = pathname.match(/^\/server\/(\d+)\/day\/(.+)$/);
    if (m) {
      return this.apiServer(m[1], m[2], req.headers);
    }

    return apiNotFound();
  }

  private apiServerList(): ApiResponse {
    const servers: { id: string; name: string; memberCount: number }[] = [];

    this.forEachGuild((guildId, config) => {
      if (config.AllowAPIAccess && (!config.APIPrivateKey || String(config.APIPrivateKey).length <= 0)) {
        const guild = this.bot.client.guilds.cache.get(guildId);
        if (guild) {
          servers.push({ id: guildId, name: guild.name, memberCount: guild.memberCount });
        }
      }
    });

    return apiOk(JSON.stringify(servers), "application/json");
  }

  private async apiServer(serverId: string, dateRaw: string, headers: http.IncomingHttpHeaders): Promise<ApiResponse> {
    if (!serverId) {
      return apiNotFound("InvalidServerId");
    }

    const dateMatch = dateRaw.match(/^\d\d\d\d-\d\d-\d\d$/);
    if (!dateMatch) {
      return apiNotFound("InvalidDate");
    }
    const date = dateMatch[0];

    const guild = this.bot.client.guilds.cache.get(serverId);
    if (!guild) {
      return apiNotFound("InvalidServerId");
    }

    const guildConfig = this.getConfig(guild, true);
    if (!guildConfig || !guildConfig.AllowAPIAccess) {
      return apiNotFound("InvalidServerId");
    }

    if (guildConfig.APIPrivateKey && String(guildConfig.APIPrivateKey).length > 0) {
      const authHeader = headers["authorization"];
      const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (!auth) {
        this.logWarning(null, "Stats API server: Access forbidden (no authorization)");
        return apiUnauthorized("MissingAuthorization");
      }

      const tokenMatch = auth.match(/^Bearer (.+)$/);
      if (!tokenMatch) {
        return apiBadRequest("InvalidAuthorizationHeader");
      }

      if (tokenMatch[1] !== guildConfig.APIPrivateKey) {
        this.logWarning(null, "Stats API server: Access forbidden (wrong token)");
        return apiUnauthorized();
      }
    }

    const stats = await this.loadStats(guild, this.getStatsFilename(guild, date));
    if (!stats) {
      return apiNotFound("NoData");
    }

    return apiOk(JSON.stringify(stats), "application/json");
  }

  // --- Event hooks (ported from the lua Module:OnXxx handlers) ---------------

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) return;
    if (message.author.bot) return;
    if (!message.guild) return;

    const data = this.getPersistentData(message.guild)!;
    data.Stats.MessageCount += 1;

    const channelStats = this.getChannelStats(message.guild, message.channel as any);
    channelStats.MessageCount += 1;

    const userStats = this.getUserStats(message.guild, message.author.id);
    userStats.MessageCount += 1;
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    if (member.user.bot) return;

    const data = this.getPersistentData(member.guild)!;
    data.Stats.MemberJoined += 1;
    data.Stats.MemberCount += 1;
  }

  async onGuildMemberRemove(member: GuildMember): Promise<void> {
    if (member.user?.bot) return;

    const data = this.getPersistentData(member.guild)!;
    data.Stats.MemberLeft += 1;
    data.Stats.MemberCount -= 1;
  }

  // discord.js unifies discordia's split OnReactionAdd/OnReactionAddUncached
  // (cached vs uncached message) into a single event backed by partials.
  async onMessageReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return;
      }
    }

    if (!this.bot.isPublicChannel(reaction.message.channel as any)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const idOrName = reaction.emoji.id ?? reaction.emoji.name;
    if (!idOrName) return;

    const emojiData = this.bot.getEmojiData(guild, idOrName);
    if (!emojiData) return;

    const data = this.getPersistentData(guild)!;
    data.Stats.ReactionAdded += 1;

    const channelStats = this.getChannelStats(guild, reaction.message.channel as any);
    channelStats.ReactionCount += 1;

    const reactionStats = this.getReactionStats(guild, emojiData.name);
    reactionStats.ReactionCount += 1;

    const userStats = this.getUserStats(guild, user.id);
    userStats.ReactionCount += 1;
  }

  // NOTE on fidelity: the lua module had two distinct handlers here —
  // `OnReactionRemove` (cached: uses the raw emojiId/emojiName as-is) and
  // `OnReactionRemoveUncached` (uncached: resolves through GetEmojiData first
  // and bails out if the emoji can't be found). discord.js merges both paths
  // into one partial-backed event; `reaction.partial` tells us which lua path
  // we're mirroring, so both behaviors are preserved below.
  async onMessageReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    const wasUncached = reaction.partial;
    if (wasUncached) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return;
      }
    }

    if (!this.bot.isPublicChannel(reaction.message.channel as any)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    let reactionKey: string | undefined;
    if (wasUncached) {
      const idOrName = reaction.emoji.id ?? reaction.emoji.name ?? undefined;
      if (!idOrName) return;
      const emojiData = this.bot.getEmojiData(guild, idOrName);
      if (!emojiData) return;
      reactionKey = emojiData.name;
    } else {
      reactionKey = reaction.emoji.id ?? reaction.emoji.name ?? undefined;
    }

    const data = this.getPersistentData(guild)!;
    data.Stats.ReactionRemoved += 1;

    const reactionStats = this.getReactionStats(guild, reactionKey);
    reactionStats.ReactionCount = Math.max(reactionStats.ReactionCount - 1, 0);
  }
}

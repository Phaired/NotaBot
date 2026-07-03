// Ported from module_twitch.lua (+ twitchapi.lua) — watches Twitch channels via
// EventSub webhooks and posts "went live" notifications to configured Discord
// channels. Also exposes admin lookup commands (!twitchinfo, !twitchgameinfo,
// !twitchstream).
//
// PORTING NOTES (framework gaps / deliberate deviations from the Lua source):
//  - The Lua module ran its own coro-net HTTP server to receive Twitch EventSub
//    webhook callbacks. There's no equivalent helper in the TS framework (it's
//    not a Discord API concern), so this file uses Node's built-in `http` +
//    `crypto` modules directly to reimplement that tiny server. This is a local
//    workaround confined to this module, per the porting rules.
//  - `twitchapi.lua`'s coro-http calls are ported using global `fetch`. Its
//    request "lock"/"unlock" mutex (meant to serialize calls) is reproduced with
//    a promise queue. Its computed rate-limit `delay` was only ever actually
//    applied for the internal 429/5xx/401 retry-sleep — `Unlock(delay)` in the
//    original ignored the argument entirely (its signature took none), so the
//    "wait out the rate limit before letting the next request through" behavior
//    never really happened in the Lua bot either; that quirk is preserved.
//  - `ValidateConfig` for TwitchConfig intentionally does NOT accept a
//    "ForbiddenGames" field (only "AllowedGames"), even though the runtime
//    notification filter (`HandleChannelNotification`) supports both. This
//    mirrors an inconsistency already present in module_twitch.lua's
//    ValidateConfig (ForbiddenGames could never actually pass validation there
//    either) — kept as-is for fidelity.
//  - `TitlePattern` values are matched with JS `RegExp` instead of Lua patterns
//    (the two syntaxes are different; there's no Lua-pattern engine available in
//    TS). Simple patterns behave the same; anything using Lua-specific pattern
//    syntax (%d, %a, ...) will not match the same way. Invalid patterns are
//    logged and skipped instead of matching.
//  - Two apparent bugs in the Lua source were fixed rather than reproduced,
//    since reproducing them would just crash the module at runtime for no
//    behavioral benefit: `UnsubscribeFromTwitch` referenced an undefined global
//    `watchedChannels` (fixed to use `self:GetWatchedChannels()`), and
//    `CreateScheduledEvent`'s error log referenced an undefined `channelData`
//    (fixed to use the actual `channelId` parameter). Both are annotated inline.

import * as http from "http";
import * as crypto from "crypto";
import {
  PermissionFlagsBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  type Guild,
  type Role,
} from "discord.js";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType, type ParseResult } from "../core/configTypes";
import type { Timer } from "../core/timer";
import { validateSnowflake } from "../util/snowflake";
import { osTime, formatTime, discordRelativeTimestamp } from "../util/time";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract `.msg` from an API error object, or fall back to the raw value (mirrors `err.msg` in the Lua source). */
function apiErrMsg(err: any): any {
  return err && typeof err === "object" ? err.msg : err;
}

interface ChannelAlertPattern {
  Channel: string;
  Message: string;
  TitlePattern?: string | string[];
  AllowedGames?: number[];
  ForbiddenGames?: number[];
  ShouldCreateDiscordEvent?: boolean;
  CreateDiscordEventDuration?: number;
}

interface WatchedChannelData {
  LastAlert: number;
  RenewTime: number;
  Subscribed: boolean;
  WaitingForConfirm: boolean;
  Secret?: string;
  ChannelUpEventId?: string;
}

interface CachedProfileData {
  CachedAt?: number;
  DisplayName?: string;
  Name?: string;
  Image?: string;
}

interface CachedGameData {
  CachedAt?: number;
  Id?: string;
  Image?: string;
  Name?: string;
}

// --- Minimal Twitch Helix API client (ported from twitchapi.lua) ------------

const ENDPOINTS = {
  EventSubSubscriptions: "https://api.twitch.tv/helix/eventsub/subscriptions",
  GetGames: "https://api.twitch.tv/helix/games",
  GetStreams: "https://api.twitch.tv/helix/streams",
  GetUsers: "https://api.twitch.tv/helix/users",
};

interface TwitchToken {
  accessToken: string;
  expirationTime: number;
  tokenType: string;
}

interface ApiLogger {
  info: (fmt: string, ...args: any[]) => void;
  warning: (fmt: string, ...args: any[]) => void;
  error: (fmt: string, ...args: any[]) => void;
}

class TwitchApiClient {
  private token?: TwitchToken;
  // Serializes requests, mirroring twitchapi.lua's Lock()/Unlock() coroutine mutex.
  private queue: Promise<any> = Promise.resolve();

  constructor(
    private readonly logger: ApiLogger,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async authenticate(): Promise<[true] | [undefined, string]> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
    });

    let res: Response;
    try {
      res = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    } catch (e: any) {
      this.logger.error("Failed to request Twitch Token (is network down?): %s", e?.message ?? e);
      return [undefined, "NetworkError"];
    }

    const body = await res.text();
    if (!res.ok) {
      this.logger.error("Failed to request Twitch Token (are credentials still valid?) (code %d)", res.status);
      return [undefined, body];
    }

    let tokenData: any;
    try {
      tokenData = JSON.parse(body);
    } catch {
      return [undefined, "Invalid token response"];
    }

    let tokenType: string = tokenData.token_type ?? "";
    if (tokenType.length > 0) tokenType = tokenType[0].toUpperCase() + tokenType.slice(1);

    this.token = {
      accessToken: tokenData.access_token,
      expirationTime: osTime() + Number(tokenData.expires_in),
      tokenType,
    };

    return [true];
  }

  private async commit(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    retries: number,
    forceAuth = false,
  ): Promise<[any, any]> {
    if (forceAuth || !this.token || osTime() > this.token.expirationTime) {
      const [ok, err] = await this.authenticate();
      if (!ok) throw new Error(`Twitch authentication failed: ${err}`);
    }

    const finalHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (lower === "authorization" || lower === "client-id") continue;
      finalHeaders[k] = v;
    }
    finalHeaders["Authorization"] = `${this.token!.tokenType} ${this.token!.accessToken}`;
    finalHeaders["Client-ID"] = this.clientId;

    let res: Response;
    try {
      res = await fetch(url, { method, headers: finalHeaders, body });
    } catch (e: any) {
      this.logger.error("Request failed : %s %s", method, url);
      return [undefined, e?.message ?? String(e)];
    }

    let delay = 0;
    const reset = res.headers.get("ratelimit-reset");
    const remaining = res.headers.get("ratelimit-remaining");
    if (reset && remaining === "0") {
      const dateHeader = res.headers.get("date");
      const headerSeconds = dateHeader ? Math.floor(new Date(dateHeader).getTime() / 1000) : osTime();
      const dt = Number(reset) - headerSeconds;
      delay = Math.max(dt * 1000, delay);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const data = contentType.includes("application/json") && text.length > 0 ? JSON.parse(text) : text;

    if (res.status < 300) {
      this.logger.info("%d - %s : %s %s", res.status, res.statusText, method, url);
      return [data, undefined];
    }

    const maxRetries = 5;
    let retry = false;
    if (res.status === 429) {
      // Too Many Requests
      retry = retries < maxRetries;
    } else if (res.status >= 500) {
      delay = delay + Math.floor(Math.random() * 2000);
      retry = retries < maxRetries;
    } else if (res.status === 401) {
      delay = 100;
      retry = retries < maxRetries;
      forceAuth = true;
    }

    if (retry) {
      this.logger.warning("%d - %s : retrying after %d ms : %s %s", res.status, res.statusText, delay, method, url);
      await sleep(delay);
      return this.commit(method, url, headers, body, retries + 1, forceAuth);
    }

    this.logger.error("%d - %s : %s %s", res.status, res.statusText, method, url);
    return [undefined, { code: res.status, msg: data }];
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async request(method: string, endpoint: string, parameters?: Record<string, any>): Promise<[any, any]> {
    let url = endpoint;
    let body: string | undefined;
    const headers: Record<string, string> = {};

    if (parameters && Object.keys(parameters).length > 0) {
      if (method === "GET" || method === "DELETE") {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(parameters)) qs.set(k, String(v));
        url = `${endpoint}?${qs.toString()}`;
      } else if (method === "POST") {
        body = JSON.stringify(parameters);
        headers["Content-Type"] = "application/json; charset=utf-8";
      } else {
        throw new Error(`Invalid method ${method}`);
      }
    }

    return this.lock(async (): Promise<[any, any]> => {
      try {
        const [data, err] = await this.commit(method, url, headers, body, 0);
        return data ? [data, undefined] : [undefined, err];
      } catch (e: any) {
        return [undefined, e?.message ?? String(e)];
      }
    });
  }

  async getGameById(gameId: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetGames, { id: gameId });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async getGameByName(gameName: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetGames, { name: gameName });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async getStreamByUserId(userId: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetStreams, { user_id: userId });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async getStreamByUserName(userName: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetStreams, { user_login: userName });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async getUserById(userId: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetUsers, { id: userId });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async getUserByName(userName: string): Promise<[any, any]> {
    const [body, err] = await this.request("GET", ENDPOINTS.GetUsers, { login: userName });
    return body?.data ? [body.data[0], undefined] : [undefined, err];
  }

  async listSubscriptions(): Promise<[any, any]> {
    return this.request("GET", ENDPOINTS.EventSubSubscriptions);
  }

  async subscribeWebHook(type: string, userId: string, callback: string, secret: string): Promise<[any, any]> {
    const parameters = {
      type,
      version: "1",
      condition: { broadcaster_user_id: userId },
      transport: { method: "webhook", callback, secret },
    };
    return this.request("POST", ENDPOINTS.EventSubSubscriptions, parameters);
  }

  async subscribeToStreamUp(userId: string, callback: string, secret: string): Promise<[any, any]> {
    return this.subscribeWebHook("stream.online", userId, callback, secret);
  }

  async unsubscribe(subscriptionId: string): Promise<[any, any]> {
    return this.request("DELETE", ENDPOINTS.EventSubSubscriptions, { id: subscriptionId });
  }
}

// --- Module -------------------------------------------------------------------

export default class TwitchModule extends BotModule {
  name = "twitch";

  private api!: TwitchApiClient;
  /** twitchChannelId -> guildId -> notification rules (from that guild's TwitchConfig). */
  private channelAlerts: Record<string, Record<string, ChannelAlertPattern[]>> = {};
  private server?: http.Server;
  private tickTimer?: Timer;
  private gameCache: Record<string, CachedGameData> = {};
  private profileCache: Record<string, CachedProfileData> = {};

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "TwitchConfig",
        Description: "List of watched channels with title patterns for messages to post on channel goes up",
        Type: ConfigType.Custom,
        Default: {},
        ValidateConfig: (value: any): ParseResult<boolean> => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return [undefined, "TwitchConfig must be an object"];
          }

          for (const [channelId, notificationData] of Object.entries(value)) {
            const [okChannel] = validateSnowflake(channelId);
            if (!okChannel) return [undefined, "TwitchConfig keys must be channel snowflakes"];

            if (!Array.isArray(notificationData)) {
              return [undefined, `TwitchConfig[${channelId}] must be an array`];
            }

            for (let i = 0; i < notificationData.length; i++) {
              const channelData = notificationData[i];
              let hasChannel = false;
              let hasMessage = false;

              if (typeof channelData !== "object" || channelData === null || Array.isArray(channelData)) {
                return [undefined, `TwitchConfig[${channelId}][${i}] must be an object`];
              }

              for (const [fieldName, fieldValue] of Object.entries(channelData)) {
                if (fieldName === "AllowedGames") {
                  if (!Array.isArray(fieldValue)) {
                    return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} must be an array`];
                  }
                  for (let j = 0; j < fieldValue.length; j++) {
                    if (typeof fieldValue[j] !== "number" || !Number.isInteger(fieldValue[j])) {
                      return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName}[${j}] is not an integer`];
                    }
                  }
                } else if (fieldName === "Channel") {
                  const [okSnowflake] = validateSnowflake(fieldValue);
                  if (!okSnowflake) {
                    return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} must be a channel snowflake`];
                  }
                  hasChannel = true;
                } else if (fieldName === "Message") {
                  if (typeof fieldValue !== "string") {
                    return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} must be a string`];
                  }
                  hasMessage = true;
                } else if (fieldName === "TitlePattern") {
                  if (Array.isArray(fieldValue)) {
                    for (let j = 0; j < fieldValue.length; j++) {
                      if (typeof fieldValue[j] !== "string") {
                        return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName}[${j}] is not a string`];
                      }
                    }
                  } else if (typeof fieldValue !== "string") {
                    return [
                      undefined,
                      `TwitchConfig[${channelId}][${i}].${fieldName} must be a string or a table of string`,
                    ];
                  }
                } else if (fieldName === "ShouldCreateDiscordEvent") {
                  if (typeof fieldValue !== "boolean") {
                    return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} must be a boolean`];
                  }
                } else if (fieldName === "CreateDiscordEventDuration") {
                  if (typeof fieldValue !== "number") {
                    return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} must be a number`];
                  }
                } else {
                  return [undefined, `TwitchConfig[${channelId}][${i}].${fieldName} is not a valid field`];
                }
              }

              if (!hasChannel) return [undefined, `TwitchConfig[${channelId}][${i}] is lacking a Channel field`];
              if (!hasMessage) return [undefined, `TwitchConfig[${channelId}][${i}] is lacking a Message field`];
            }
          }

          return [true];
        },
      },
      {
        Global: true,
        Name: "CallbackEndpoint",
        Description: "URI which will be sent to Twitch for channel events",
        Type: ConfigType.String,
        Default: "",
      },
      {
        Global: true,
        Name: "ListenPort",
        Description: "Port on which internal server listens",
        Type: ConfigType.Integer,
        Default: 14793,
      },
      {
        Global: true,
        Name: "SilenceDuration",
        Description: "Duration during which a stream won't trigger other notifications after a notification",
        Type: ConfigType.Duration,
        Default: 30 * 60,
      },
      {
        Global: true,
        Name: "TwitchClientId",
        Description: "Twitch application client id",
        Type: ConfigType.String,
        Default: "",
        Sensitive: true,
      },
      {
        Global: true,
        Name: "TwitchClientSecret",
        Description: "Twitch application secret",
        Type: ConfigType.String,
        Default: "",
        Sensitive: true,
      },
    ];
  }

  private getWatchedChannels(): Record<string, WatchedChannelData> {
    const persistentData = this.getPersistentData(null)!;
    if (!persistentData.watchedChannels) persistentData.watchedChannels = {};
    return persistentData.watchedChannels;
  }

  async onLoaded(): Promise<boolean> {
    this.api = new TwitchApiClient(
      {
        info: (fmt: string, ...args: any[]) => this.logInfo(null, fmt, ...args),
        warning: (fmt: string, ...args: any[]) => this.logWarning(null, fmt, ...args),
        error: (fmt: string, ...args: any[]) => this.logError(null, fmt, ...args),
      },
      this.globalConfig.TwitchClientId,
      this.globalConfig.TwitchClientSecret,
    );

    this.channelAlerts = {};

    const watchedChannels = this.getWatchedChannels();
    for (const channelData of Object.values(watchedChannels)) {
      channelData.WaitingForConfirm = false;
    }

    // Mirrors the Lua `discordia.Clock():on("sec", ...)` — ticks once per second.
    this.tickTimer = this.bot.createRepeatTimer(1, -1, () => this.tickWatchedChannels());

    this.server = await this.setupServer();
    if (!this.server) {
      this.logError(null, "Failed to setup server");
      return false;
    }

    this.registerCommand({
      Name: "twitchinfo",
      Args: [{ Name: "channel", Type: ConfigType.String, Description: "Twitch channel name or id" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Query twitch informations about a channel",
      Func: async (ctx, channelArg) => {
        const channel = String(channelArg);
        const [profileData, err] = /^\d+$/.test(channel)
          ? await this.api.getUserById(channel)
          : await this.api.getUserByName(channel);

        if (profileData) {
          const channelUrl = `https://www.twitch.tv/${profileData.login}`;
          await ctx.reply({
            embed: {
              title: profileData.display_name,
              description: profileData.description,
              url: channelUrl,
              author: { name: profileData.login, url: channelUrl, icon_url: profileData.profile_image_url },
              thumbnail: { url: profileData.profile_image_url },
              fields: [
                { name: "View count", value: String(profileData.view_count) },
                {
                  name: "Type",
                  value:
                    typeof profileData.broadcaster_type === "string" && profileData.broadcaster_type.length > 0
                      ? profileData.broadcaster_type
                      : "regular",
                },
              ],
              image: { url: profileData.offline_image_url },
              footer: { text: `ID: ${profileData.id}` },
            },
          });
        } else if (err) {
          await ctx.reply(`An error occurred: ${String(err)}`);
        } else {
          await ctx.reply(`Profile \`${channel}\` not found`);
        }
      },
    });

    this.registerCommand({
      Name: "twitchgameinfo",
      Args: [{ Name: "channel", Type: ConfigType.String, Description: "Twitch game name or id" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Query twitch informations about a game",
      Func: async (ctx, channelArg) => {
        const channel = String(channelArg);
        const [gameData, err] = /^\d+$/.test(channel)
          ? await this.api.getGameById(channel)
          : await this.api.getGameByName(channel);

        if (gameData) {
          const thumbnail = String(gameData.box_art_url).split("{width}").join("285").split("{height}").join("380");

          await ctx.reply({
            embed: {
              title: gameData.name,
              image: { url: thumbnail },
              footer: { text: `ID: ${gameData.id}` },
            },
          });
        } else if (err) {
          await ctx.reply(`An error occurred: ${String(err)}`);
        } else {
          await ctx.reply(`Game \`${channel}\` not found`);
        }
      },
    });

    this.registerCommand({
      Name: "twitchstream",
      Args: [{ Name: "channel", Type: ConfigType.String, Description: "Twitch channel name or id" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Query twitch informations about a ongoing stream",
      Func: async (ctx, channelArg) => {
        const channel = String(channelArg);
        const [streamData, err] = /^\d+$/.test(channel)
          ? await this.api.getStreamByUserId(channel)
          : await this.api.getStreamByUserName(channel);

        if (streamData) {
          await this.sendChannelNotification(ctx.guild!, ctx.channel, "", streamData).catch((e: any) =>
            this.logError(ctx.guild, "Failed to send twitch notification message: %s", e?.message ?? e),
          );
        } else if (err) {
          await ctx.reply(`An error occurred: ${String(err)}`);
        } else {
          await ctx.reply(`Stream \`${channel}\` not found`);
        }
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild);
    if (config) this.handleConfig(guild, config);
    return true;
  }

  private handleConfig(guild: Guild, config: Record<string, any>): void {
    const watchedChannels = this.getWatchedChannels();

    // Remove all alerts for this guild before reapplying them.
    for (const channelId of Object.keys(this.channelAlerts)) {
      delete this.channelAlerts[channelId][guild.id];
    }

    const twitchConfig: Record<string, ChannelAlertPattern[]> = config.TwitchConfig ?? {};
    for (const [channelId, channelData] of Object.entries(twitchConfig)) {
      let watchedData = watchedChannels[channelId];
      if (!watchedData) {
        watchedData = { LastAlert: 0, RenewTime: osTime(), Subscribed: false, WaitingForConfirm: false };
        watchedChannels[channelId] = watchedData;
      }

      let channelAlerts = this.channelAlerts[channelId];
      if (!channelAlerts) {
        channelAlerts = {};
        this.channelAlerts[channelId] = channelAlerts;
      }

      channelAlerts[guild.id] = channelData;
    }
  }

  handleConfigUpdate(guild: Guild | null, config: Record<string, any>, configName: string | null): void {
    if ((!configName || configName === "TwitchConfig") && guild) {
      this.handleConfig(guild, config);
    }
  }

  async onDisable(guild: Guild): Promise<void> {
    const config = this.getConfig(guild);
    if (!config) return;
    for (const channelId of Object.keys(config.TwitchConfig ?? {})) {
      const channelAlerts = this.channelAlerts[channelId];
      if (channelAlerts) delete channelAlerts[guild.id];
    }
  }

  async onUnload(): Promise<void> {
    this.tickTimer?.stop();
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private tickWatchedChannels(): void {
    const watchedChannels = this.getWatchedChannels();
    const now = osTime();
    for (const channelId of Object.keys(watchedChannels)) {
      const channelData = watchedChannels[channelId];
      if (channelData.RenewTime <= now && !channelData.Subscribed) {
        const channelAlerts = this.channelAlerts[channelId];
        if (channelAlerts && Object.keys(channelAlerts).length > 0) {
          channelData.RenewTime = now + 30; // Retry in 30 seconds if twitch didn't answer or subscribing failed
          this.subscribeToTwitch(channelId).catch((e: any) =>
            this.logError(null, "SubscribeToTwitch(%s) failed: %s", channelId, e?.message ?? e),
          );
        } else {
          delete watchedChannels[channelId];
          delete this.channelAlerts[channelId];
        }
      }
    }
  }

  // --- HTTP server (EventSub webhook receiver) --------------------------------

  private setupServer(): Promise<http.Server | undefined> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handleHttpRequest(req, res));
      server.once("error", (err: any) => {
        this.logError(null, "Twitch server: failed to listen on port %d: %s", this.globalConfig.ListenPort, err?.message ?? err);
        resolve(undefined);
      });
      server.listen(this.globalConfig.ListenPort, "127.0.0.1", () => resolve(server));
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        this.processWebhookRequest(req.headers, body, res);
      } catch (e: any) {
        this.logError(null, "Twitch server: unhandled error: %s", e?.message ?? e);
        try {
          res.writeHead(500, { "Content-Type": "charset=utf-8", "Content-Length": "0" });
          res.end();
        } catch {
          // ignore
        }
      }
    });
    req.on("error", () => {
      try {
        res.writeHead(500, { "Content-Type": "charset=utf-8", "Content-Length": "0" });
        res.end();
      } catch {
        // ignore
      }
    });
  }

  private processWebhookRequest(headers: http.IncomingHttpHeaders, body: string, res: http.ServerResponse): void {
    const forbidden = () => {
      this.logWarning(null, "Twitch server: Access forbidden");
      res.writeHead(403, { "Content-Type": "charset=utf-8", "Content-Length": "0" });
      res.end();
    };
    const ok = () => {
      res.writeHead(200, { "Content-Type": "charset=utf-8", "Content-Length": "0" });
      res.end();
    };
    const serverError = () => {
      this.logWarning(null, "Twitch server: Server error");
      res.writeHead(500, { "Content-Type": "charset=utf-8", "Content-Length": "0" });
      res.end();
    };

    const messageType = headers["twitch-eventsub-message-type"] as string | undefined;
    const headerSignature = headers["twitch-eventsub-message-signature"] as string | undefined;
    const subscriptionType = (headers["twitch-eventsub-subscription-type"] as string | undefined) ?? "";

    if (!messageType) {
      this.logError(null, "Twitch Server: no message type");
      return forbidden();
    }

    if (!headerSignature) {
      this.logError(null, "Twitch Server: no message signature");
      return forbidden();
    }

    const sigMatch = headerSignature.match(/^(\w+)=(\w+)$/);
    if (!sigMatch || sigMatch[1] !== "sha256") {
      this.logError(null, "Twitch server: Invalid header signature %s", headerSignature);
      return forbidden();
    }
    const hashValue = sigMatch[2];

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      this.logError(null, "Twitch server: invalid JSON payload");
      return forbidden();
    }

    const userId = payload?.subscription?.condition?.broadcaster_user_id;
    if (!userId) {
      this.logError(null, "Twitch server: payload missing subscription.condition.broadcaster_user_id");
      return forbidden();
    }

    const watchedChannels = this.getWatchedChannels();
    const channelData = watchedChannels[userId];
    if (!channelData) {
      this.logError(null, "%s is not a watched channel, ignoring...", userId);
      return forbidden();
    }

    const messageId = headers["twitch-eventsub-message-id"] as string | undefined;
    const timestamp = headers["twitch-eventsub-message-timestamp"] as string | undefined;
    if (!messageId || !timestamp) {
      this.logError(null, "Twitch server: missing message id/timestamp header");
      return forbidden();
    }

    if (!channelData.Secret) {
      this.logError(null, "Twitch server: no secret registered for channel %s", userId);
      return forbidden();
    }

    const hmacMessage = messageId + timestamp + body;
    const signature = crypto.createHmac("sha256", channelData.Secret).update(hmacMessage).digest("hex");
    if (hashValue !== signature) {
      this.logError(null, "Hash doesn't match");
      return forbidden();
    }

    // Okay message is from Twitch, handle it.
    if (messageType === "notification") {
      this.logInfo(null, "Twitch server: Received %s notification for channel %s", subscriptionType, userId);
      this.handleChannelNotification(userId, channelData, subscriptionType, payload.event).catch((e: any) =>
        this.logError(null, "HandleChannelNotification failed: %s", e?.message ?? e),
      );
    } else if (messageType === "webhook_callback_verification") {
      this.logInfo(null, "Twitch server: Subscribed to %s for channel %s", subscriptionType, userId);

      if (!channelData.WaitingForConfirm) {
        this.logError(null, 'Twitch server: Channel "%s" is not waiting for Twitch confirmation', userId);
        return forbidden();
      }

      channelData.Subscribed = true;
      channelData.WaitingForConfirm = false;

      const challenge = String(payload.challenge ?? "");
      res.writeHead(200, { "Content-Type": "charset=utf-8", "Content-Length": String(Buffer.byteLength(challenge)) });
      res.end(challenge);
      return;
    } else if (messageType === "revocation") {
      this.logInfo(null, "Twitch server: Unsubscribed from %s for channel %s", subscriptionType, userId);
      channelData.RenewTime = osTime();
      channelData.Subscribed = false;
      channelData.WaitingForConfirm = false;
      channelData.ChannelUpEventId = undefined;
    } else {
      this.logError(null, "Twitch server: Unknown messageType %s", messageType);
      return serverError();
    }

    ok();
  }

  // --- Notification handling ---------------------------------------------------

  private async handleChannelNotification(
    channelId: string,
    channelData: WatchedChannelData,
    type: string,
    eventData: any,
  ): Promise<void> {
    if (type !== "stream.online") {
      this.logWarning(null, "unexpected event %s for channel %s", type, channelId);
      return;
    }

    const channelAlerts = this.channelAlerts[channelId];
    if (!channelAlerts) {
      this.logError(null, "%s has no active alerts, ignoring...", channelId);
      return;
    }

    const now = osTime();
    if (now - channelData.LastAlert < this.globalConfig.SilenceDuration) {
      this.logInfo(null, "Dismissed alert event because last one occured %s ago", formatTime(now - channelData.LastAlert));
      return;
    }

    const startTimestamp = Math.floor(new Date(eventData.started_at).getTime() / 1000);
    if (channelData.LastAlert > startTimestamp) {
      this.logInfo(
        null,
        "Dismissed alert event because last one occured while the stream was active (%s ago)",
        formatTime(now - channelData.LastAlert),
      );
      return;
    }

    // There may be a race condition between Twitch notifying a stream started and stream
    // info fetching, try multiple times with a small delay.
    let streamData: any;
    for (let i = 1; i <= 10; i++) {
      this.logInfo(null, "trying to retrieve stream info for %s (attempt %d/10)", channelId, i);
      const [data, err] = await this.api.getStreamByUserId(channelId);
      if (data) {
        streamData = data;
        break;
      }
      if (err) this.logError(null, "couldn't retrieve stream info for %s: %s", channelId, apiErrMsg(err));
      await sleep(1000);
    }

    if (!streamData) return;

    channelData.LastAlert = now;

    const title: string = streamData.title;
    const gameId: string = streamData.game_id;

    const checkPattern = (pattern: ChannelAlertPattern): boolean => {
      if (pattern.TitlePattern) {
        const patterns = Array.isArray(pattern.TitlePattern) ? pattern.TitlePattern : [pattern.TitlePattern];
        let doesMatch = false;
        for (const titlePattern of patterns) {
          try {
            if (new RegExp(titlePattern).test(title)) {
              doesMatch = true;
              break;
            }
          } catch {
            this.logWarning(null, "TwitchConfig TitlePattern %s is not a valid regular expression", titlePattern);
          }
        }
        if (!doesMatch) return false;
      }

      if (pattern.AllowedGames) {
        if (!pattern.AllowedGames.some((v) => String(v) === gameId)) return false;
      } else if (pattern.ForbiddenGames) {
        if (pattern.ForbiddenGames.some((v) => String(v) === gameId)) return false;
      }

      return true;
    };

    for (const [guildId, guildPatterns] of Object.entries(channelAlerts)) {
      const guild = this.bot.client.guilds.cache.get(guildId);
      if (!guild) continue;

      for (const pattern of guildPatterns) {
        if (checkPattern(pattern)) {
          const channel = guild.channels.cache.get(pattern.Channel);
          if (channel) {
            await this.sendChannelNotification(guild, channel, pattern.Message, streamData).catch((e: any) =>
              this.logError(guild, "Failed to send twitch notification message: %s", e?.message ?? e),
            );
            if (pattern.ShouldCreateDiscordEvent) {
              await this.createScheduledEvent(guild, channelId, title, pattern.CreateDiscordEventDuration || 3600).catch(
                () => {},
              );
            }
          } else {
            this.logError(guild, "Channel %s doesn't exist", pattern.Channel);
          }

          break;
        }
      }
    }
  }

  private async createScheduledEvent(guild: Guild, channelId: string, title: string, duration: number): Promise<void> {
    const [profileData, err] = await this.getProfileData(channelId);
    if (!profileData) {
      // NOTE(port): the Lua source referenced an undefined `channelData` here (a
      // bug); this uses the actual channelId parameter instead.
      this.logError(guild, "failed to query user %s info: %s", channelId, apiErrMsg(err));
      return;
    }

    let eventTitle = `🎬 Stream: ${title}`;
    if (eventTitle.length > 100) eventTitle = eventTitle.slice(0, 97) + "...";

    const now = osTime();

    try {
      // TODO(port): "Add support for images" (already a TODO in the Lua source).
      await guild.scheduledEvents.create({
        name: eventTitle,
        description: `${profileData.Name} is currently streaming!`,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: `https://twitch.tv/${profileData.Name}` },
        scheduledStartTime: new Date((now + 5) * 1000),
        scheduledEndTime: new Date((now + duration) * 1000),
      });
    } catch {
      this.logError(guild, "failed to create scheduled event");
    }
  }

  private async getProfileData(userId: string): Promise<[CachedProfileData | undefined, any]> {
    const now = osTime();

    let profileData = this.profileCache[userId];
    if (!profileData || profileData.CachedAt === undefined || now - profileData.CachedAt > 3600) {
      const [userInfo, err] = await this.api.getUserById(userId);
      if (err) return [undefined, err];

      profileData = {};
      if (userInfo) {
        profileData.CachedAt = now;
        profileData.DisplayName = userInfo.display_name;
        profileData.Name = userInfo.login;
        profileData.Image = userInfo.profile_image_url;
      }

      this.profileCache[userId] = profileData;
    }

    return [profileData, undefined];
  }

  private async getGameData(gameId: string): Promise<[CachedGameData | undefined, any]> {
    const now = osTime();

    let gameData = this.gameCache[gameId];
    if (!gameData || gameData.CachedAt === undefined || now - gameData.CachedAt > 3600) {
      const [gameInfo, err] = await this.api.getGameById(gameId);
      if (err) return [undefined, err];

      gameData = {};
      if (gameInfo) {
        gameData.CachedAt = now;
        gameData.Id = gameInfo.id;
        gameData.Image = gameInfo.box_art_url;
        gameData.Name = gameInfo.name;
      }

      this.gameCache[gameId] = gameData;
    }

    return [gameData, undefined];
  }

  private async sendChannelNotification(guild: Guild, channel: any, message: string, channelData: any): Promise<void> {
    const [profileData, profileErr] = await this.getProfileData(channelData.user_id);
    if (!profileData || !profileData.Name) {
      this.logError(guild, "Failed to query user %s info: %s", channelData.user_id, apiErrMsg(profileErr));
      return;
    }

    const [gameData, gameErr] = await this.getGameData(channelData.game_id);
    if (!gameData || !gameData.Name) {
      this.logError(guild, "Failed to query game info about game %s: %s", channelData.game_id, apiErrMsg(gameErr));
    }

    const nonMentionableRoles: Record<string, Role> = {};
    for (const m of message.matchAll(/<@&(\d+)>/g)) {
      const roleId = m[1];
      const role = guild.roles.cache.get(roleId);
      if (role) {
        if (!role.mentionable) nonMentionableRoles[roleId] = role;
      } else {
        this.logWarning(guild, "Role %s doesn't exist", roleId);
      }
    }

    const gameName = gameData?.Name ?? `<game ${channelData.game_id}>`;

    const substitutions: Record<string, string> = {
      display_name: profileData.DisplayName ?? "",
      game_name: gameName,
      title: channelData.title,
    };
    const finalMessage = message.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(substitutions, key) ? substitutions[key] : match,
    );

    const channelUrl = `https://www.twitch.tv/${profileData.Name}`;
    const thumbnail = `${channelData.thumbnail_url}?${osTime()}` // Bypass Discord image caching
      .split("{width}")
      .join("320")
      .split("{height}")
      .join("180");

    for (const [roleId, role] of Object.entries(nonMentionableRoles)) {
      await role
        .setMentionable(true)
        .catch((e: any) =>
          this.logWarning(guild, "Failed to enable mentioning on role %s (%s): %s", roleId, role.name, e?.message ?? e),
        );
    }

    const fields: { name: string; value: string }[] = [];
    if (gameData?.Name) fields.push({ name: "Game", value: gameName });
    if (channelData.viewer_count > 0) fields.push({ name: "Viewers", value: String(channelData.viewer_count) });

    const startDate = Math.floor(new Date(channelData.started_at).getTime() / 1000);
    fields.push({ name: "Started", value: discordRelativeTimestamp(startDate) });

    try {
      await channel.send({
        content: finalMessage,
        embeds: [
          {
            title: channelData.title,
            url: channelUrl,
            author: { name: profileData.Name, url: channelUrl, icon_url: profileData.Image },
            thumbnail: { url: profileData.Image },
            fields,
            image: { url: thumbnail },
            timestamp: channelData.started_at,
          },
        ],
      });
    } catch (e: any) {
      this.logError(guild, "Failed to send twitch notification message: %s", e?.message ?? e);
    }

    for (const [roleId, role] of Object.entries(nonMentionableRoles)) {
      await role
        .setMentionable(false)
        .catch((e: any) =>
          this.logWarning(
            guild,
            "Failed to re-disable mentioning on role %s (%s): %s",
            roleId,
            role.name,
            e?.message ?? e,
          ),
        );
    }
  }

  // --- Subscription management --------------------------------------------------

  private generateSecret(length: number): string {
    const charset: string[] = [];
    for (let c = 48; c <= 57; c++) charset.push(String.fromCharCode(c)); // 0-9
    for (let c = 65; c <= 90; c++) charset.push(String.fromCharCode(c)); // A-Z
    for (let c = 97; c <= 122; c++) charset.push(String.fromCharCode(c)); // a-z

    let res = "";
    for (let i = 0; i < length; i++) {
      res += charset[Math.floor(Math.random() * charset.length)];
    }
    return res;
  }

  private async subscribeToTwitch(channelId: string): Promise<[any, any]> {
    this.logInfo(null, "Subscribing to channel %s", channelId);

    const watchedChannels = this.getWatchedChannels();
    const channelData = watchedChannels[channelId];
    if (!channelData) throw new Error(`watched channel ${channelId} not found`);

    if (channelData.ChannelUpEventId) {
      await this.unsubscribeFromTwitch(channelId).catch(() => {});
    }

    channelData.WaitingForConfirm = true;
    channelData.Secret = this.generateSecret(32);

    let ret: any;
    let err: any;
    try {
      [ret, err] = await this.api.subscribeToStreamUp(channelId, this.globalConfig.CallbackEndpoint, channelData.Secret);
    } catch (e) {
      ret = undefined;
      err = e;
    }

    if (!ret) {
      channelData.WaitingForConfirm = false;

      if (err && typeof err === "object" && err.code === 409) {
        // Conflict, this subscription already exists.
        this.logInfo(null, "subscription already exist");

        const [subscriptions, listErr] = await this.api.listSubscriptions();
        if (!subscriptions) {
          this.logError(null, "failed to list current subscriptions: %s", apiErrMsg(listErr));
          return [false, apiErrMsg(listErr)];
        }

        for (const subscription of subscriptions.data ?? []) {
          if (subscription.condition.broadcaster_user_id === channelId) {
            await this.api.unsubscribe(subscription.id).catch(() => {});
            break;
          }
        }

        // Try again (the per-second tick will retry once RenewTime elapses).
        return [undefined, undefined];
      }

      this.logError(null, "An error occurred: %s", apiErrMsg(err));
      return [false, apiErrMsg(err)];
    }

    channelData.ChannelUpEventId = ret.data.id;

    return [ret, err];
  }

  private async unsubscribeFromTwitch(channelId: string): Promise<[any, any] | undefined> {
    // NOTE(port): the Lua source read from an undefined global `watchedChannels`
    // here (a bug — likely meant `self:GetWatchedChannels()`), which would throw
    // at runtime. Fixed to look the channel up through persistent data properly.
    const channelData = this.getWatchedChannels()[channelId];
    if (channelData && channelData.ChannelUpEventId) {
      this.logInfo(null, "Unsubscribing from channel %s", channelId);
      return this.api.unsubscribe(channelData.ChannelUpEventId);
    }
    return undefined;
  }
}

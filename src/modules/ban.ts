// Ported from module_ban.lua — ban/unban members with an optional duration,
// tracking bans persistently and auto-unbanning once the duration expires.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";
import { osTime, discordRelativeTime } from "../util/time";
import {
  AuditLogEvent,
  PermissionFlagsBits,
  type Guild,
  type GuildBan,
  type GuildMember,
  type User,
} from "discord.js";

interface BanRecord {
  BannedAt?: number;
  BannedBy?: string;
  ExpirationTime?: number;
  Reason?: string;
}

interface UnbanEntry {
  Time: number;
  UserId: string;
}

export default class BanModule extends BotModule {
  name = "ban";

  private unbanTimer?: Timer;

  private checkPermissions(member: GuildMember | null): boolean {
    return !!member?.permissions.has(PermissionFlagsBits.BanMembers);
  }

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "DefaultBanDuration",
        Description: "Default ban duration if no duration is set",
        Type: ConfigType.Duration,
        Default: 24 * 60 * 60,
      },
      {
        Name: "SendPrivateMessage",
        Description:
          "Should the bot try to send a private message right before banning someone? (including who banned them and for what)",
        Type: ConfigType.Boolean,
        Default: true,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "ban",
      Args: [
        { Name: "target", Type: ConfigType.User, Description: "User to ban" },
        { Name: "duration", Type: ConfigType.Duration, Optional: true, Description: "Ban duration" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Ban reason" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Bans a member",
      Silent: true,
      Func: async (ctx, targetUser: User, durationArg: number | undefined, reasonArg: string | undefined) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const bannedBy = ctx.member!;

        // Duration
        const duration = durationArg ?? config.DefaultBanDuration;

        // Reason
        const reason = reasonArg ?? "";

        const targetMember = guild.members.cache.get(targetUser.id);
        if (targetMember) {
          const bannedByRole = bannedBy.roles.highest;
          const targetRole = targetMember.roles.highest;
          if (targetRole.position >= bannedByRole.position) {
            return ctx.reply("You cannot ban that user due to your lower permissions.");
          }
        }

        if (config.SendPrivateMessage) {
          const privateChannel = await targetUser.createDM().catch(() => undefined);
          if (privateChannel) {
            let durationText: string;
            if (duration > 0) {
              durationText = `You will be unbanned ${discordRelativeTime(duration)}`;
            } else {
              durationText = "";
            }

            await privateChannel
              .send(
                `You have been banned from **${guild.name}** by ${bannedBy.user.toString()} (${
                  reason.length > 0 ? "reason: " + reason : "no reason given"
                })\n${durationText}`,
              )
              .catch(() => {});
          }
        }

        const data = this.getData(guild)!;
        data.BanInProgress[targetUser.id] = true;
        try {
          await guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: 0 });
        } catch {
          delete data.BanInProgress[targetUser.id];
          return ctx.reply(`Failed to ban ${targetUser.tag}`);
        }

        const durationText = duration > 0 ? "for " + discordRelativeTime(duration) : "permanent";
        await ctx.reply(
          `${bannedBy.displayName} has banned ${targetUser.tag} (${durationText})${
            reason.length > 0 ? " for the reason: " + reason : ""
          }`,
        );

        await this.registerBan(guild, targetUser.id, ctx.author, duration, reason);
      },
    });

    this.registerCommand({
      Name: "unban",
      Args: [
        { Name: "target", Type: ConfigType.User, Description: "User to unban" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Unban reason" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Unbans a member",
      Silent: true,
      Func: async (ctx, targetUser: User, reasonArg: string | undefined) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;

        // Reason
        const reason = reasonArg ?? "";

        if (config.SendPrivateMessage) {
          const privateChannel = await targetUser.createDM().catch(() => undefined);
          if (privateChannel) {
            await privateChannel
              .send(
                `You have been unbanned from **${guild.name}** by ${ctx.member!.user.toString()} (${
                  reason.length > 0 ? "reason: " + reason : "no reason given"
                })`,
              )
              .catch(() => {});
          }
        }

        try {
          await guild.members.unban(targetUser.id, reason);
          await ctx.reply(
            `${ctx.member!.displayName} has unbanned ${targetUser.tag}${
              reason.length > 0 ? " for the reason: " + reason : ""
            }`,
          );
        } catch (err: any) {
          await ctx.reply(`Failed to unban ${targetUser.tag}: ${err?.message ?? String(err)}`);
        }
      },
    });

    this.registerCommand({
      Name: "updatebanduration",
      Args: [
        { Name: "target", Type: ConfigType.User, Description: "Banned user" },
        { Name: "new_duration", Type: ConfigType.Duration, Description: "New ban duration" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Updates the ban duration",
      Silent: true,
      Func: async (ctx, targetUser: User, newDuration: number) => {
        const guild = ctx.guild!;

        if (await this.updateBanDuration(guild, targetUser.id, newDuration)) {
          await ctx.reply(
            `${ctx.member!.displayName} has updated ${targetUser.tag} ban duration (${
              newDuration > 0 ? "unbanned " + discordRelativeTime(newDuration) : "banned permanently"
            })`,
          );
        } else {
          await ctx.reply(`${targetUser.tag} is not banned`);
        }
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const persistentData = this.getPersistentData(guild)!;
    persistentData.BannedUsers = persistentData.BannedUsers ?? {};

    const data = this.getData(guild)!;
    data.BanInProgress = {};
    data.UnbanTable = [];

    await this.syncBans(guild);

    for (const [userId, banData] of Object.entries<BanRecord>(persistentData.BannedUsers)) {
      const expiration = banData.ExpirationTime;
      if (expiration) {
        this.registerBanExpiration(guild, userId, expiration);
      }
    }

    return true;
  }

  async onReady(): Promise<void> {
    if (!this.unbanTimer) {
      this.unbanTimer = this.bot.createRepeatTimer(1, -1, () => this.unbanTick());
    }
  }

  async onUnload(): Promise<void> {
    this.unbanTimer?.stop();
    this.unbanTimer = undefined;
  }

  // --- Helpers (ported 1:1 from the lua Module: methods) --------------------

  private getBannedUsersTable(guild: Guild): Record<string, BanRecord> {
    const persistentData = this.getPersistentData(guild)!;
    return persistentData.BannedUsers;
  }

  private async registerBan(guild: Guild, userId: string, bannedByUser: User, duration: number, reason: string) {
    const bannedUsers = this.getBannedUsersTable(guild);

    const now = osTime();
    let expiration: number | undefined;
    if (duration > 0) {
      expiration = now + duration;
      this.registerBanExpiration(guild, userId, expiration);
    }

    bannedUsers[userId] = {
      BannedAt: now,
      BannedBy: bannedByUser.id,
      ExpirationTime: expiration,
      Reason: reason && reason.length > 0 ? reason : undefined,
    };

    await this.savePersistentData(guild);
  }

  /** `banDate` is expressed in unix seconds (equivalent to lua's discordia.Date). */
  private updateBanData(
    guild: Guild,
    userId: string,
    bannedByUserId: string,
    banDate?: number,
    duration?: number,
    reason?: string,
  ) {
    const bannedUsers = this.getBannedUsersTable(guild);

    const banData = bannedUsers[userId];
    if (!banData) return;

    let expiration: number | undefined;
    if (duration && duration > 0 && banDate !== undefined) {
      expiration = banDate + duration;
    }

    banData.BannedBy = bannedByUserId;

    if (banDate !== undefined) {
      banData.BannedAt = banDate;
    }

    if (duration) {
      banData.ExpirationTime = expiration;
      this.registerBanExpiration(guild, userId, expiration!);
    }

    if (reason) {
      banData.Reason = reason;
    }
  }

  private async updateBanDuration(guild: Guild, userId: string, duration: number): Promise<boolean> {
    const bannedUsers = this.getBannedUsersTable(guild);
    if (!bannedUsers[userId]) return false;

    let expiration: number | undefined;
    if (duration > 0) {
      const now = osTime();
      expiration = now + duration;
      this.registerBanExpiration(guild, userId, expiration);
    }

    const banData = bannedUsers[userId];
    banData.ExpirationTime = expiration;

    return true;
  }

  private registerBanExpiration(guild: Guild, userId: string, expirationTime: number) {
    const data = this.getData(guild)!;
    const table: UnbanEntry[] = data.UnbanTable;
    table.push({ Time: expirationTime, UserId: userId });
    table.sort((a, b) => a.Time - b.Time);
  }

  private async syncBans(guild: Guild) {
    const bannedUsers = this.getBannedUsersTable(guild);

    // Retrieve all banned users in the guild
    let guildBans;
    try {
      guildBans = await guild.bans.fetch();
    } catch (err: any) {
      this.logWarning(guild, "Failed to retrieve guild ban: %s", String(err?.message ?? err));
      return;
    }

    const guildBanned: Record<string, boolean> = {};
    const missingBanData: Record<string, boolean> = {};
    for (const ban of guildBans.values()) {
      const user = ban.user;
      if (!bannedUsers[user.id]) {
        this.logInfo(
          guild,
          "Found banned user %s in guild which is not logged (ban reason: %s)",
          user.tag,
          ban.reason ?? "<none>",
        );

        missingBanData[user.id] = true;

        bannedUsers[user.id] = {
          Reason: ban.reason ?? undefined,
        };
      }

      guildBanned[user.id] = true;
    }

    // Check if any user is still logged as banned by user but not by the guild
    const unbannedUsers: string[] = [];
    for (const userId of Object.keys(bannedUsers)) {
      if (!guildBanned[userId]) {
        const user = this.bot.client.users.cache.get(userId);
        if (user) {
          this.logWarning(
            guild,
            "User %s is logged as banned but is not found in the guild ban list, removing...",
            user.tag,
          );
        }

        unbannedUsers.push(userId);
      }
    }

    for (const userId of unbannedUsers) {
      delete bannedUsers[userId];
    }

    // Try to recover some ban information from the guild audit logs
    if (Object.keys(missingBanData).length > 0) {
      let before: string | undefined;
      const limit = 100;

      for (let i = 0; i < 10; i++) {
        // Limit
        let guildAuditLogs;
        try {
          guildAuditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit, before });
        } catch {
          this.logWarning(guild, "Failed to get audit logs");
          return;
        }

        const auditLogs = [...guildAuditLogs.entries.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const log of auditLogs) {
          const bannedUser = log.target as User | null;

          if (bannedUser && missingBanData[bannedUser.id]) {
            const bannedByExecutor = log.executor;
            const date = Math.floor(log.createdTimestamp / 1000);

            this.logInfo(
              guild,
              "Found audit log data for %s ban (banned by %s at %s)",
              bannedUser.tag,
              bannedByExecutor?.tag ?? "<unknown>",
              new Date(log.createdTimestamp).toISOString(),
            );
            this.updateBanData(guild, log.targetId ?? bannedUser.id, bannedByExecutor?.id ?? "0", date);

            delete missingBanData[bannedUser.id];
          }
        }

        if (auditLogs.length < limit || Object.keys(missingBanData).length === 0) {
          break;
        }

        before = auditLogs[auditLogs.length - 1].id;
      }
    }

    if (Object.keys(missingBanData).length > 0) {
      this.logWarning(
        guild,
        "%s bans without audit log remains, these will be counted as permanent bans made by unknowns",
        Object.keys(missingBanData).length,
      );
    }

    await this.savePersistentData(guild);
  }

  async onGuildBanAdd(ban: GuildBan): Promise<void> {
    const guild = ban.guild;
    const user = ban.user;

    const data = this.getData(guild)!;
    if (!data.BanInProgress[user.id]) {
      // Try to recover some ban information from the guild audit logs
      try {
        const guildAuditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 20 });
        const auditLogs = [...guildAuditLogs.entries.values()].sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp,
        );

        for (const log of auditLogs) {
          if (log.targetId === user.id) {
            const bannedByExecutor = log.executor ?? user;

            await this.registerBan(guild, user.id, bannedByExecutor as User, 0, log.reason ?? "");
            this.logInfo(
              guild,
              "Registered manual ban of %s by %s at %s (reason: %s)",
              user.tag,
              bannedByExecutor.tag,
              new Date(log.createdTimestamp).toISOString(),
              log.reason ?? "<no reason>",
            );

            return;
          }
        }
      } catch {
        // fall through to the warning below
      }

      this.logWarning(guild, "Failed to retrieve informations about manual ban of %s at %s", user.tag, new Date().toISOString());
    } else {
      delete data.BanInProgress[user.id];
    }
  }

  async onGuildBanRemove(ban: GuildBan): Promise<void> {
    const guild = ban.guild;
    const user = ban.user;

    const bannedUsers = this.getBannedUsersTable(guild);
    delete bannedUsers[user.id];
    await this.savePersistentData(guild);
  }

  private unbanTick(): void {
    const now = osTime();
    this.forEachGuild((_guildId, _config, data, persistentData, guild) => {
      if (!guild) return;

      const bannedUsers: Record<string, BanRecord> = persistentData.BannedUsers ?? {};

      const unbanTable: UnbanEntry[] = data.UnbanTable ?? [];
      const unbanData = unbanTable[0];
      if (unbanData && now >= unbanData.Time) {
        // Double check ban info
        const userId = unbanData.UserId;
        const banData = bannedUsers[userId];
        if (banData && banData.ExpirationTime && now >= banData.ExpirationTime) {
          const user = this.bot.client.users.cache.get(userId);
          if (user) {
            this.logInfo(guild, "Unbanning %s (duration expired)", user.tag);
            guild.members.unban(userId, "Ban duration expired").catch(() => {});
          }

          delete bannedUsers[userId];
        }

        unbanTable.shift();
      }
    });
  }
}

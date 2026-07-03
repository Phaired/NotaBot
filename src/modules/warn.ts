// Ported from module_warn.lua — warns members, keeps a per-member warn history
// and (optionally) escalates to a mute/ban notice once configured thresholds
// are reached.
//
//  Storage Model (PersistentData)
//
//  {
//    "Warns": {
//      "<UserId>": [ { "WarnedBy": "<ModeratorId>", "Reason": "..." }, ... ],
//      ...
//    }
//  }

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { PermissionFlagsBits, type Guild, type GuildMember, type User } from "discord.js";

interface WarnEntry {
  WarnedBy: string;
  Reason: string;
}

export default class WarnModule extends BotModule {
  name = "warn";

  checkPermissions(member: GuildMember | null): boolean {
    return !!member?.permissions.has(PermissionFlagsBits.BanMembers);
  }

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Sanctions",
        Description: "Enable sanctions over members.",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "WarnAmountToMute",
        Description: "Number of warns needed to mute the member.",
        Type: ConfigType.Integer,
        Default: 3,
      },
      {
        Name: "WarnAmountToBan",
        Description: "Number of warns needed to tempban the member.",
        Type: ConfigType.Integer,
        Default: 9,
      },
      {
        Name: "DefaultMuteDuration",
        Description: "Default mute duration when reached enough warns.",
        Type: ConfigType.Duration,
        Default: 60 * 60,
      },
      {
        Name: "BanInformationChannel",
        Description: "Default channel where all the ban-able members are listed.",
        Type: ConfigType.Channel,
        Default: "",
      },
      {
        Name: "SendPrivateMessage",
        Description: "Sends the warning to the user in private message.",
        Type: ConfigType.Boolean,
        Default: true,
      },
    ];
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;

    const banInfo = config.BanInformationChannel ? guild.channels.cache.get(config.BanInformationChannel) : undefined;
    if (!banInfo) {
      // NOTE(port): the lua hook returned a second value ("Invalid ban information
      // channel, check your configuration.") but BotModule.onEnable only supports a
      // boolean return in this framework; the caller substitutes a generic
      // "onEnable hook returned false" message instead.
      return false;
    }

    return true;
  }

  // Ensures history.Warns[memberId] exists and appends the new warn to it.
  private addWarn(history: Record<string, any>, memberId: string, moderatorId: string, reason: string): void {
    if (!history.Warns) history.Warns = {};
    if (!history.Warns[memberId]) history.Warns[memberId] = [];
    (history.Warns[memberId] as WarnEntry[]).push({ WarnedBy: moderatorId, Reason: reason });
  }

  // TODO(port): one-time migration from the pre-"Warns" storage format, ported
  // from ConvertDataFormat (module_warn.lua). Upstream lua already marks this
  // "TODO delete this" — kept for parity with legacy persisted data.
  private convertDataFormat(
    _guildId: string,
    _config: Record<string, any>,
    _data: Record<string, any>,
    persistentData: any,
  ): void {
    if (!persistentData || persistentData.Warns !== undefined) return;

    const legacyEntries: any[] = Array.isArray(persistentData)
      ? persistentData
      : Object.keys(persistentData)
          .filter((k) => /^\d+$/.test(k))
          .map((k) => persistentData[k]);

    persistentData.Warns = {};
    for (const entry of legacyEntries) {
      if (!entry || !entry.UserId) continue;
      if (!persistentData.Warns[entry.UserId]) persistentData.Warns[entry.UserId] = [];
      for (const warn of entry.Warns ?? []) {
        persistentData.Warns[entry.UserId].push({ WarnedBy: warn.From, Reason: warn.Reason });
      }
    }

    if (Array.isArray(persistentData)) {
      persistentData.length = 0;
    } else {
      for (const k of Object.keys(persistentData)) {
        if (/^\d+$/.test(k)) delete persistentData[k];
      }
    }
  }

  async onLoaded(): Promise<boolean> {
    // TODO delete this (matches upstream comment)
    this.forEachGuild(
      (guildId, config, data, persistentData) => this.convertDataFormat(guildId, config, data, persistentData),
      true,
      true,
      true,
    );

    this.registerCommand({
      Name: "warn",
      Args: [
        { Name: "target", Type: ConfigType.User, Description: "Member to warn" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),

      Help: (guild) => this.bot.format(guild, "WARN_WARN_HELP"),
      Silent: true,
      Func: async (ctx, targetUser: User, reasonArg?: string) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const history = this.getPersistentData(guild) ?? {};
        const reason = reasonArg || this.bot.format(guild, "GLOBAL_DEFAULT_REASON");
        const infoChannel = config.BanInformationChannel ? guild.channels.cache.get(config.BanInformationChannel) : undefined;

        const targetMember = guild.members.cache.get(targetUser.id);
        const moderator = ctx.member!;

        // Permission check
        if (targetMember) {
          const bannedByRole = moderator.roles.highest;
          const targetRole = targetMember.roles.highest;
          if (targetRole.position >= bannedByRole.position) {
            await ctx.reply(this.bot.format(guild, "WARN_WARN_PERMISSION_DENIED"));
            return;
          }
        }

        // Add warn to the user
        const targetId = targetUser.id;
        const moderatorId = moderator.id;
        this.addWarn(history, targetId, moderatorId, reason);

        if (config.SendPrivateMessage) {
          await targetUser.send(this.bot.format(guild, "WARN_WARN_PM", guild.name, reason)).catch(() => {});
        }

        // Falls back to the plain User tag if the target already left the guild
        // (the lua original assumed targetMember was always set here).
        const targetTag = (targetMember?.user ?? targetUser).tag;

        const warnAmount = history.Warns[targetId].length;
        await ctx.reply(this.bot.format(guild, "WARN_WARN_MSG", moderator.user.tag, targetTag, warnAmount, reason));

        if (config.Sanctions) {
          const banThreshold = config.WarnAmountToBan;
          const muteThreshold = config.WarnAmountToMute;

          if (warnAmount % banThreshold === 0) {
            await (infoChannel as any)?.send(
              this.bot.format(guild, "WARN_WARN_BAN_REACHED", targetTag, targetId, warnAmount),
            ).catch(() => {});

            return;
          }

          if (warnAmount % muteThreshold === 0) {
            const duration = config.DefaultMuteDuration * (warnAmount / muteThreshold);
            await (infoChannel as any)?.send(
              this.bot.format(guild, "WARN_WARN_MUTE_REACHED", targetTag, targetId, warnAmount, duration),
            ).catch(() => {});

            const muteModule = this.bot.getModuleForGuild(guild, "mute") as any;
            if (muteModule && targetMember) {
              await muteModule.mute?.(guild, targetMember.id, duration).catch(() => {});
            }
          }
        }
      },
    });

    this.registerCommand({
      Name: "warnlist",
      Args: [{ Name: "targetUser", Type: ConfigType.User, Description: "Member to inspect" }],
      PrivilegeCheck: (member) => this.checkPermissions(member),

      Help: (guild) => this.bot.format(guild, "WARN_WARNLIST_HELP"),
      Silent: true,
      Func: async (ctx, targetUser: User) => {
        const guild = ctx.guild!;
        const history = this.getPersistentData(guild) ?? {};
        const warns: WarnEntry[] | undefined = history.Warns?.[targetUser.id];

        if (!warns) {
          await ctx.reply(this.bot.format(guild, "WARN_NO_WARNS", targetUser.tag, targetUser.id));
        } else {
          let message = this.bot.format(guild, "WARN_WARNLIST_LIST", targetUser.tag, targetUser.id);
          for (const warn of warns) {
            const warnedBy = await this.bot.client.users.fetch(warn.WarnedBy).catch(() => undefined);
            const reason = warn.Reason || this.bot.format(guild, "GLOBAL_DEFAULT_REASON"); // TODO this line may be deleted when timers will be implemented
            message += this.bot.format(guild, "WARN_WARNLIST_ITEM", warnedBy?.tag ?? warn.WarnedBy, reason);
          }
          await ctx.reply(message);
        }
      },
    });

    this.registerCommand({
      Name: "clearwarns",
      Args: [{ Name: "targetUser", Type: ConfigType.User, Description: "Member to clear warns for" }],
      PrivilegeCheck: (member) => this.checkPermissions(member),

      Help: (guild) => this.bot.format(guild, "WARN_CLEARWARNS_HELP"),
      Silent: true,
      Func: async (ctx, targetUser: User) => {
        const guild = ctx.guild!;
        const history = this.getPersistentData(guild) ?? {};

        if (!history.Warns?.[targetUser.id]) {
          await ctx.reply(this.bot.format(guild, "WARN_NO_WARNS", targetUser.tag, targetUser.id));
        } else {
          delete history.Warns[targetUser.id];
          await ctx.reply(this.bot.format(guild, "WARN_CLEARWARNS_CLEARED", targetUser.tag, targetUser.id));
          await this.bot.save();
        }
      },
    });

    return true;
  }
}

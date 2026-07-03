// Ported from module_mute.lua — mutes/unmutes members via a configured role,
// automatically re-applies denied permissions on text/voice channels, persists
// mutes across restarts and schedules automatic unmutes.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
} from "discord.js";
import { osTime, discordRelativeTime } from "../util/time";

// Permission bits forcibly denied for the mute role on text-capable channels.
const TEXT_MUTE_DENY =
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.CreatePublicThreads |
  PermissionFlagsBits.SendMessagesInThreads;

// Permission bits forcibly denied for the mute role on voice channels.
const VOICE_MUTE_DENY = PermissionFlagsBits.Speak;

export default class MuteModule extends BotModule {
  name = "mute";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Array: true,
        Name: "AuthorizedRoles",
        Description: "Roles allowed to use mute commands",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "DefaultMuteDuration",
        Description: "Default mute duration if no duration is set",
        Type: ConfigType.Duration,
        Default: 10 * 60,
      },
      {
        Name: "SendPrivateMessage",
        Description: "Should the bot try to send a private message when muting someone?",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "MuteRole",
        Description: "Mute role to be applied (no need to configure its permissions)",
        Type: ConfigType.Role,
        Default: "",
      },
    ];
  }

  private memberHasAnyRole(member: GuildMember, roleIds: string[] | undefined): boolean {
    if (!roleIds) return false;
    return roleIds.some((id) => member.roles.cache.has(id));
  }

  private checkPermissions(member: GuildMember | null): boolean {
    if (!member) return false;
    const config = this.getConfig(member.guild);
    if (config && this.memberHasAnyRole(member, config.AuthorizedRoles)) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return false;
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "mute",
      Args: [
        { Name: "target", Type: ConfigType.Member, Description: "Member to mute" },
        { Name: "duration", Type: ConfigType.Duration, Optional: true, Description: "Mute duration" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),

      Help: "Mutes a member",
      Silent: true,
      Func: async (ctx, targetMember: GuildMember, durationArg?: number, reasonArg?: string) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const mutedBy = ctx.member!;

        // Duration
        const duration = durationArg ?? config.DefaultMuteDuration;

        // Reason
        const reason =
          reasonArg && reasonArg.length > 0 ? " " + this.bot.format(guild, "MUTE_REASON", reasonArg) : "";

        const mutedByRole = mutedBy.roles.highest;
        const targetRole = targetMember.roles.highest;
        if (targetRole.position >= mutedByRole.position) {
          return ctx.reply(this.bot.format(guild, "MUTE_NOTAUTHORIZED"));
        }

        if (config.SendPrivateMessage) {
          const durationText =
            duration > 0
              ? "\n" + this.bot.format(guild, "MUTE_YOU_WILL_BE_UNMUTED_IN", discordRelativeTime(duration))
              : "";

          await targetMember
            .send(this.bot.format(guild, "MUTE_PRIVATE_MESSAGE", guild.name, mutedBy.user.toString(), reason, durationText))
            .catch(() => {});
        }

        const [success, err] = await this.mute(guild, targetMember.id, duration);
        if (success) {
          const durationText =
            duration > 0
              ? "\n" + this.bot.format(guild, "MUTE_THEY_WILL_BE_UNMUTED_IN", discordRelativeTime(duration))
              : "";

          await ctx.reply(
            this.bot.format(guild, "MUTE_GUILD_MESSAGE", mutedBy.displayName, targetMember.user.tag, reason, durationText),
          );
        } else {
          await ctx.reply(this.bot.format(guild, "MUTE_MUTE_FAILED", targetMember.user.tag, err));
        }
      },
    });

    this.registerCommand({
      Name: "unmute",
      Args: [
        { Name: "target", Type: ConfigType.User, Description: "User to unmute" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),

      Help: "Unmutes a member",
      Silent: true,
      Func: async (ctx, targetUser: any, reasonArg?: string) => {
        const guild = ctx.guild!;

        // Reason
        const reason =
          reasonArg && reasonArg.length > 0 ? " " + this.bot.format(guild, "MUTE_REASON", reasonArg) : "";

        const config = this.getConfig(guild)!;
        if (config.SendPrivateMessage) {
          await targetUser
            .send(this.bot.format(guild, "MUTE_UNMUTE_MESSAGE", guild.name, ctx.member!.user.toString(), reason))
            .catch(() => {});
        }

        const [success, err] = await this.unmute(guild, targetUser.id);
        if (success) {
          await ctx.reply(this.bot.format(guild, "MUTE_UNMUTE_GUILD_MESSAGE", ctx.member!.displayName, targetUser.tag, reason));
        } else {
          await ctx.reply(this.bot.format(guild, "MUTE_UNMUTE_FAILED", targetUser.tag, err));
        }
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;

    const muteRole = config.MuteRole ? guild.roles.cache.get(config.MuteRole) : undefined;
    if (!muteRole) {
      // NOTE(port): the lua hook returned a second value ("Invalid mute role
      // (check your configuration)") but BotModule.onEnable only supports a
      // boolean return in this framework; the caller substitutes a generic
      // "onEnable hook returned false" message instead.
      return false;
    }

    this.logInfo(guild, "Checking mute role permission on all channels...");

    for (const channel of guild.channels.cache.values()) {
      if (channel.type === ChannelType.GuildText) {
        await this.checkTextMutePermissions(channel as any);
      } else if (channel.type === ChannelType.GuildVoice) {
        await this.checkVoiceMutePermissions(channel as any);
      }
    }

    const persistentData = this.getPersistentData(guild)!;
    if (!persistentData.MutedUsers) persistentData.MutedUsers = {};

    const data = this.getData(guild)!;
    data.UnmuteTimers = {};

    for (const [userId, unmuteTimestamp] of Object.entries(persistentData.MutedUsers)) {
      this.registerUnmute(guild, userId, unmuteTimestamp as number);
    }

    return true;
  }

  async onDisable(guild: Guild): Promise<void> {
    const data = this.getData(guild);
    if (data?.UnmuteTimers) {
      for (const timer of Object.values(data.UnmuteTimers) as Timer[]) {
        timer.stop();
      }
    }
  }

  // --- Channel permission maintenance ----------------------------------------

  private async ensureMuteOverwrite(channel: any, guild: Guild, extraDenyBits: bigint): Promise<void> {
    const config = this.getConfig(guild)!;
    const mutedRole = config.MuteRole ? guild.roles.cache.get(config.MuteRole) : undefined;
    if (!mutedRole) {
      this.logError(guild, "Invalid muted role");
      return;
    }

    const existing = channel.permissionOverwrites.cache.get(mutedRole.id);
    const currentAllow: bigint = existing?.allow.bitfield ?? 0n;
    const currentDeny: bigint = existing?.deny.bitfield ?? 0n;
    const newDeny = currentDeny | extraDenyBits;

    // Mirrors the lua check: only push an update if something actually changes.
    if (currentAllow !== 0n || currentDeny !== newDeny) {
      const options: Record<string, boolean> = {};
      for (const flag of new PermissionsBitField(newDeny).toArray()) options[flag] = false;
      await channel.permissionOverwrites
        .create(mutedRole, options)
        .catch((e: any) => this.logError(guild, "Failed to update mute permissions on #%s: %s", channel.name, e?.message ?? e));
    }
  }

  async checkTextMutePermissions(channel: any): Promise<void> {
    await this.ensureMuteOverwrite(channel, channel.guild, TEXT_MUTE_DENY);
  }

  async checkVoiceMutePermissions(channel: any): Promise<void> {
    await this.ensureMuteOverwrite(channel, channel.guild, VOICE_MUTE_DENY);
  }

  // --- Mute / unmute core (also callable cross-module via getModuleForGuild) -

  async mute(guild: Guild, userId: string, duration: number): Promise<[true] | [false, string]> {
    const config = this.getConfig(guild)!;
    const member = guild.members.cache.get(userId);
    if (!member) {
      return [false, this.bot.format(guild, "MUTE_ERROR_NOT_PART_OF_GUILD", `<@${userId}>`)];
    }

    try {
      await member.roles.add(config.MuteRole);
    } catch (e: any) {
      const err = e?.message ?? String(e);
      this.logError(guild, "failed to mute %s: %s", member.user.tag, err);
      return [false, err];
    }

    const persistentData = this.getPersistentData(guild)!;
    if (!persistentData.MutedUsers) persistentData.MutedUsers = {};
    const unmuteTimestamp = duration > 0 ? osTime() + duration : 0;

    persistentData.MutedUsers[userId] = unmuteTimestamp;
    this.registerUnmute(guild, userId, unmuteTimestamp);

    return [true];
  }

  private registerUnmute(guild: Guild, userId: string, timestamp: number): void {
    if (timestamp !== 0) {
      const data = this.getData(guild)!;
      if (!data.UnmuteTimers) data.UnmuteTimers = {};
      const timer: Timer | undefined = data.UnmuteTimers[userId];
      if (timer) timer.stop();

      data.UnmuteTimers[userId] = this.bot.scheduleTimer(timestamp, async () => {
        await this.unmute(guild, userId);
      });
    }
  }

  async unmute(guild: Guild, userId: string): Promise<[true] | [false, string]> {
    const config = this.getConfig(guild)!;

    const member = guild.members.cache.get(userId);
    if (member) {
      try {
        await member.roles.remove(config.MuteRole);
      } catch (e: any) {
        const err = e?.message ?? String(e);
        this.logError(guild, "Failed to unmute %s: %s", member.user.tag, err);
        return [false, err];
      }
    }

    const data = this.getData(guild)!;
    const timer: Timer | undefined = data.UnmuteTimers?.[userId];
    if (timer) {
      timer.stop();
      delete data.UnmuteTimers[userId];
    }

    const persistentData = this.getPersistentData(guild)!;
    if (persistentData.MutedUsers) delete persistentData.MutedUsers[userId];

    return [true];
  }

  // --- Events ------------------------------------------------------------

  async onChannelCreate(channel: any): Promise<void> {
    if (channel.type === ChannelType.GuildText) {
      await this.checkTextMutePermissions(channel);
    } else if (channel.type === ChannelType.GuildVoice) {
      await this.checkVoiceMutePermissions(channel);
    }
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild;

    const config = this.getConfig(guild)!;
    const persistentData = this.getPersistentData(guild)!;
    if (persistentData.MutedUsers && persistentData.MutedUsers[member.id] !== undefined) {
      try {
        await member.roles.add(config.MuteRole);
      } catch (e: any) {
        this.logError(guild, "failed to apply mute role to %s: %s", member.user.tag, e?.message ?? e);
      }
    }
  }
}

// Ported from module_modo.lua — the "report a message" / moderator-alert module.
//
// Users react to a message with a configured trigger emoji to report it. The
// module posts (and updates) an alert embed in a moderator channel with buttons
// / select menus to dismiss, delete the message, open a modmail ticket, mute or
// ban the reported user. It also auto-mutes / pings moderators once enough
// reports pile up, and keeps a periodic sweep to lift auto-mutes once they
// expire, plus keeps the mute role's channel overwrites in sync.

import {
  ChannelType,
  ComponentType,
  ButtonStyle,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Message,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type TextChannel,
  type VoiceChannel,
  type GuildChannel,
  type Role,
  type ButtonInteraction,
  type AnySelectMenuInteraction,
  type GuildTextBasedChannel,
} from "discord.js";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";
import { osTime, formatTime, discordRelativeTime } from "../util/time";

interface ReportedMessageData {
  AlertMessageId?: string;
  ChannelId: string;
  Components: any[];
  Dismissed: boolean;
  Embed: any;
  MessageId: string;
  ReportedUserId: string;
  ReporterIds: string[];
  MuteApplied?: boolean;
  ModeratorPinged?: boolean;
}

export default class ModoModule extends BotModule {
  name = "modo";

  private muteCheckTimer?: Timer;

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Trigger",
        Description: "Triggering emoji",
        Type: ConfigType.Emoji,
        Default: "modo",
      },
      {
        Name: "AlertChannel",
        Description: "Channel where alerts will be posted",
        Type: ConfigType.Channel,
        Default: "",
      },
      {
        Array: true,
        Name: "ImmunityRoles",
        Description: "Roles immune to moderators reactions",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "ModeratorPingThreshold",
        Description: "How many moderation emoji reactions are required to trigger a moderator ping (0 to disable)",
        Type: ConfigType.Integer,
        Default: 5,
      },
      {
        Name: "ModeratorRole",
        Description: "Which role should be pinged when a message reach the moderator ping threshold",
        Type: ConfigType.Role,
        Default: "",
      },
      {
        Name: "MuteThreshold",
        Description: "How many moderation emoji reactions are required to auto-mute the original poster (0 to disable)",
        Type: ConfigType.Integer,
        Default: 10,
      },
      {
        Name: "MuteDuration",
        Description: "Duration of auto-mute",
        Type: ConfigType.Duration,
        Default: 10 * 60,
      },
      {
        Name: "MuteRole",
        Description: "Auto-mute role to be applied (no need to configure its permissions)",
        Type: ConfigType.Role,
        Default: "",
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    // All the interactive bits (dismiss/delete/modmail/mute/ban) share the
    // "alertmodule_" custom_id prefix, exactly like the lua single
    // OnInteractionCreate dispatcher.
    this.bot.interactions.registerComponent("alertmodule_", (interaction) => this.handleAlertInteraction(interaction));
    return true;
  }

  async onReady(): Promise<void> {
    // lua: self.Clock:start() — only start the periodic mute sweep once ready.
    this.muteCheckTimer = this.bot.createRepeatTimer(60, -1, () => this.checkExpiredMutes());
  }

  async onUnload(): Promise<void> {
    this.muteCheckTimer?.stop();
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;

    const mentionEmoji = this.bot.getEmojiData(guild, config.Trigger);
    if (!mentionEmoji) {
      this.logError(guild, `Emoji "${config.Trigger}" not found (check your configuration)`);
      // NOTE(port): the lua OnEnable returns `false, "<message>"`; the ts BotModule
      // only supports a boolean return (see src/core/module.ts enableForGuild),
      // so the descriptive error is only visible in the log, not to the caller.
      return false;
    }

    const alertChannel = guild.channels.cache.get(config.AlertChannel);
    if (!alertChannel) {
      this.logError(guild, "Alert channel not found (check your configuration)");
      return false;
    }

    const data = this.getPersistentData(guild)!;
    data.MutedUsers = data.MutedUsers ?? {};
    data.ReportedMessages = data.ReportedMessages ?? {};
    data.AlertMessages = data.AlertMessages ?? {};

    this.logInfo(guild, "Checking mute role permission on all channels...");

    if (config.MuteRole) {
      const mutedRole = guild.roles.cache.get(config.MuteRole);
      if (mutedRole) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.type === ChannelType.GuildText) {
            await this.checkTextMutePermissions(channel as TextChannel);
          } else if (channel.type === ChannelType.GuildVoice) {
            await this.checkVoiceMutePermissions(channel as VoiceChannel);
          }
        }
      } else {
        this.logError(guild, "Invalid muted role");
        config.MuteRole = "";
        await this.saveGuildConfig(guild);
      }
    } else {
      this.logWarning(guild, "No mute role has been set");
    }

    return true;
  }

  // --- Mute role channel permission upkeep -----------------------------------

  private async checkTextMutePermissions(channel: TextChannel): Promise<void> {
    const config = this.getConfig(channel.guild)!;
    const mutedRole = channel.guild.roles.cache.get(config.MuteRole);
    if (!mutedRole) {
      this.logError(channel.guild, "Invalid muted role");
      return;
    }

    await this.applyMuteDeny(channel, mutedRole, [
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
    ]);
  }

  private async checkVoiceMutePermissions(channel: VoiceChannel): Promise<void> {
    const config = this.getConfig(channel.guild)!;
    const mutedRole = channel.guild.roles.cache.get(config.MuteRole);
    if (!mutedRole) {
      this.logError(channel.guild, "Invalid muted role");
      return;
    }

    await this.applyMuteDeny(channel, mutedRole, [PermissionFlagsBits.Speak]);
  }

  /** Force-deny `forcedBits` on `role` for `channel`, wiping any explicit allow
   * (mirrors lua's `permissions:setPermissions('0', deniedPermissions)`), while
   * preserving any pre-existing denied bits. No-op if already correct. */
  private async applyMuteDeny(channel: GuildChannel, role: Role, forcedBits: bigint[]): Promise<void> {
    const existing = channel.permissionOverwrites.cache.get(role.id);
    const existingAllowBits = existing?.allow.bitfield ?? 0n;
    const existingDenyBits = existing?.deny.bitfield ?? 0n;

    let forcedBitfield = 0n;
    for (const bit of forcedBits) forcedBitfield |= bit;
    const newDenyBits = existingDenyBits | forcedBitfield;

    if (existingAllowBits !== 0n || existingDenyBits !== newDenyBits) {
      const overwriteOptions: Record<string, boolean> = {};
      for (const name of new PermissionsBitField(newDenyBits).toArray()) {
        overwriteOptions[name] = false;
      }
      await channel.permissionOverwrites.create(role, overwriteOptions as any).catch((e: any) => {
        this.logError(channel.guild, "Failed to update mute permissions on #%s: %s", (channel as any).name, e?.message ?? e);
      });
    }
  }

  async onChannelCreate(channel: any): Promise<void> {
    if (channel.type === ChannelType.GuildText) {
      await this.checkTextMutePermissions(channel as TextChannel);
    } else if (channel.type === ChannelType.GuildVoice) {
      await this.checkVoiceMutePermissions(channel as VoiceChannel);
    }
  }

  // --- Mute / unmute -----------------------------------------------------------

  private async mute(guild: Guild, userId: string): Promise<boolean> {
    const config = this.getConfig(guild)!;
    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => undefined);
    if (!member) return false;

    try {
      await member.roles.add(config.MuteRole);
    } catch {
      return false;
    }

    const data = this.getPersistentData(guild)!;
    data.MutedUsers[userId] = osTime() + config.MuteDuration;
    return true;
  }

  private async unmute(guild: Guild, userId: string): Promise<boolean> {
    const config = this.getConfig(guild)!;

    const data = this.getPersistentData(guild)!;
    delete data.MutedUsers[userId];

    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => undefined);
    if (member) {
      try {
        await member.roles.remove(config.MuteRole);
        return true;
      } catch {
        this.logError(guild, "Failed to unmute %s", member.user.tag);
        return false;
      }
    }

    return false;
  }

  private checkExpiredMutes(): void {
    const now = osTime();
    this.forEachGuild((_guildId, _config, _data, persistentData, guild) => {
      if (!guild) return;
      for (const [userId, endTime] of Object.entries<number>(persistentData.MutedUsers ?? {})) {
        if (now >= endTime) {
          this.unmute(guild, userId).catch(() => {});
        }
      }
    });
  }

  // --- Report handling -----------------------------------------------------

  private generateJumpToComponents(message: Message): any {
    return {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          url: this.bot.generateMessageLink(message),
          label: "Jump to message",
        },
      ],
    };
  }

  private async handleEmojiAdd(userId: string, message: Message): Promise<void> {
    if (message.author?.bot) return; // Ignore bot

    const messageMember = message.member;
    if (!messageMember) return; // Ignore PM

    const guild = message.guild;
    if (!guild) return;

    const config = this.getConfig(guild)!;

    for (const roleId of config.ImmunityRoles ?? []) {
      if (messageMember.roles.cache.has(roleId)) return;
    }

    const alertChannel = this.bot.client.channels.cache.get(config.AlertChannel) as TextChannel | undefined;
    if (!alertChannel || !alertChannel.isTextBased()) {
      this.logError(guild, "Failed to get alert channel");
      return;
    }

    const data = this.getPersistentData(guild)!;

    const reportedMessage: ReportedMessageData | undefined = data.ReportedMessages[message.id];
    if (reportedMessage) {
      // Check if user already reported this message
      if (reportedMessage.ReporterIds.includes(userId)) return;

      reportedMessage.ReporterIds.push(userId);

      const reporters: string[] = [];
      for (const reporterId of reportedMessage.ReporterIds) {
        const user = this.bot.client.users.cache.get(reporterId);
        reporters.push(user ? user.toString() : "<failed to get user>");
      }

      reportedMessage.Embed.title = `${reporters.length} users reported a message`;
      reportedMessage.Embed.fields[1].name = "Reporters";
      reportedMessage.Embed.fields[1].value = reporters.join("\n");

      let alertMessage: Message | undefined;
      if (reportedMessage.AlertMessageId) {
        alertMessage = await alertChannel.messages.fetch(reportedMessage.AlertMessageId).catch(() => undefined);
      }
      if (alertMessage) {
        await alertMessage.edit({ embeds: [reportedMessage.Embed] }).catch(() => {});
      }

      if (!reportedMessage.Dismissed) {
        const reporterCount = reporters.length;

        if (config.MuteThreshold > 0 && reporterCount >= config.MuteThreshold && !reportedMessage.MuteApplied) {
          // Auto-mute
          if (config.MuteRole) {
            const reportedUser =
              this.bot.client.users.cache.get(reportedMessage.ReportedUserId) ??
              (await this.bot.client.users.fetch(reportedMessage.ReportedUserId).catch(() => undefined));
            const reportedUserMention = reportedUser ? reportedUser.toString() : `<@${reportedMessage.ReportedUserId}>`;

            if (await this.mute(guild, reportedMessage.ReportedUserId)) {
              const durationStr = discordRelativeTime(config.MuteDuration);
              await alertChannel
                .send({
                  content: `${reportedUserMention} has been auto-muted ${durationStr}`,
                  reply: alertMessage ? { messageReference: alertMessage.id } : undefined,
                })
                .catch(() => {});
              await (message.channel as any)
                .send(`${reportedUserMention} has been auto-muted for ${durationStr} due to reporting`)
                .catch(() => {});
            } else {
              await alertChannel
                .send({
                  content: `Failed to mute ${reportedUserMention}`,
                  reply: alertMessage ? { messageReference: alertMessage.id } : undefined,
                })
                .catch(() => {});
            }
          }

          reportedMessage.MuteApplied = true;
        }

        if (config.ModeratorPingThreshold > 0 && reporterCount >= config.ModeratorPingThreshold && !reportedMessage.ModeratorPinged) {
          // Ping moderators
          const moderatorRole = guild.roles.cache.get(config.ModeratorRole);
          if (moderatorRole) {
            await alertChannel
              .send({
                content: `A message has been reported ${reporterCount} times ${moderatorRole.toString()}\n<${this.bot.generateMessageLink(message)}>`,
                reply: alertMessage ? { messageReference: alertMessage.id } : undefined,
              })
              .catch(() => {});
          }

          reportedMessage.ModeratorPinged = true;
        }
      }
    } else {
      const reporterUser =
        this.bot.client.users.cache.get(userId) ?? (await this.bot.client.users.fetch(userId).catch(() => undefined));

      let content = message.cleanContent ?? "";
      if (content.length > 800) {
        content = content.slice(0, 800) + "...<truncated>";
      }
      if (!content || content.length === 0) {
        content = "<empty>";
      }

      const embedContent: any = {
        title: "One user reported a message",
        fields: [
          { name: "Reported user", value: message.author.toString(), inline: true },
          { name: "Reporter", value: reporterUser ? reporterUser.toString() : `<@${userId}>`, inline: true },
          { name: "Message channel", value: message.channel.toString() },
          { name: "Message content", value: content },
          { name: "Action history", value: "None" },
        ],
        timestamp: new Date().toISOString(),
      };

      const actionButtons: any[] = [
        {
          type: ComponentType.Button,
          custom_id: "alertmodule_dismiss",
          style: ButtonStyle.Secondary,
          label: "Dismiss alert",
          emoji: { name: "🔇" },
        },
        {
          type: ComponentType.Button,
          custom_id: "alertmodule_deletemessage",
          style: ButtonStyle.Primary,
          label: "Delete message",
          emoji: { name: "🗑️" },
        },
      ];

      const components: any[] = [this.generateJumpToComponents(message)];
      components.push({ type: ComponentType.ActionRow, components: actionButtons });

      if (this.bot.getModuleForGuild(guild, "modmail")) {
        actionButtons.push({
          type: ComponentType.Button,
          custom_id: "alertmodule_modmail",
          style: ButtonStyle.Primary,
          label: "Open a modmail ticket",
          emoji: { name: "⚠️" },
        });
      }

      {
        // Mute
        const muteDurations = [10 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60, 0];
        const options = muteDurations.map((duration) => ({
          label: duration > 0 ? `Mute for ${formatTime(duration)}` : "Mute indefinitely",
          value: String(duration),
        }));

        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "alertmodule_mute",
              placeholder: "🙊 Mute member",
              disabled: this.bot.getModuleForGuild(guild, "mute") === null,
              options,
            },
          ],
        });
      }

      // NOTE(port): lua checks the "mute" module (not "ban") to decide whether
      // temp-bans are available — preserved verbatim from module_modo.lua.
      const tempBanAvailable = this.bot.getModuleForGuild(guild, "mute") !== null;
      {
        // Ban
        const banDurations = [60 * 60, 6 * 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60];
        const options: any[] = banDurations.map((duration) => ({
          label: `Ban for ${formatTime(duration)}`,
          value: String(duration),
          disabled: !tempBanAvailable,
        }));

        options.push({ label: "Ban permanently", value: "0" });
        options.push({ label: "Ban permanently and delete last 24h messages", value: "0_deletemessages" });

        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: "alertmodule_ban",
              placeholder: "🔨 Ban member",
              options,
            },
          ],
        });
      }

      const alertMessage = await alertChannel.send({ embeds: [embedContent], components }).catch(() => undefined);

      if (!alertMessage) {
        this.logError(guild, "Failed to post alert message (too long?) for %s", this.bot.generateMessageLink(message));
      }

      const reportedMessageData: ReportedMessageData = {
        AlertMessageId: alertMessage?.id,
        ChannelId: message.channel.id,
        Components: components,
        Dismissed: false,
        Embed: embedContent,
        MessageId: message.id,
        ReportedUserId: message.author.id,
        ReporterIds: [userId],
      };

      data.ReportedMessages[message.id] = reportedMessageData;

      if (alertMessage) {
        data.AlertMessages[alertMessage.id] = reportedMessageData;
      }
    }
  }

  private async handleMessageRemove(channel: GuildTextBasedChannel, messageId: string): Promise<void> {
    const guild = (channel as any).guild as Guild | undefined;
    if (!guild) return;

    const data = this.getPersistentData(guild)!;

    const reportedMessage: ReportedMessageData | undefined = data.ReportedMessages[messageId];
    if (!reportedMessage) return;

    const config = this.getConfig(guild)!;

    // Disable "jump to" button
    reportedMessage.Components[0].components[0].disabled = true;
    // Disable "delete message" button
    reportedMessage.Components[1].components[1].disabled = true;

    const alertChannel = this.bot.client.channels.cache.get(config.AlertChannel) as TextChannel | undefined;
    if (alertChannel && alertChannel.isTextBased() && reportedMessage.AlertMessageId) {
      const alertMessage = await alertChannel.messages.fetch(reportedMessage.AlertMessageId).catch(() => undefined);
      if (alertMessage) {
        await alertMessage.edit({ components: reportedMessage.Components }).catch(() => {});
      }
    }
  }

  // --- Discord event hooks -----------------------------------------------------
  // discord.js merges discordia's OnReactionAdd/OnReactionAddUncached (and
  // OnMessageDelete/OnMessageDeleteUncached) into single events that may carry
  // partial data; fetch when partial to recover the "uncached" behavior.

  async onMessageReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    try {
      if (reaction.partial) reaction = await reaction.fetch();
    } catch {
      return;
    }

    let message = reaction.message;
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }

    if (!this.bot.isPublicChannel(message.channel as any)) return;

    const guild = message.guild;
    if (!guild) return;

    const config = this.getConfig(guild)!;
    const emojiKey = reaction.emoji.id ?? reaction.emoji.name;
    if (!emojiKey) return;

    const emojiData = this.bot.getEmojiData(guild, emojiKey);
    if (!emojiData) {
      this.logWarning(guild, "Emoji %s was used but not found in guild", reaction.emoji.name ?? emojiKey);
      return;
    }

    if (emojiData.name !== config.Trigger || (emojiData.custom && emojiData.fromGuild !== guild)) return;

    let fullUser: User | PartialUser = user;
    if (fullUser.partial) {
      fullUser = await fullUser.fetch().catch(() => fullUser);
    }

    await this.handleEmojiAdd(fullUser.id, message as Message);
  }

  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    const channel = message.channel as GuildTextBasedChannel;
    if (!this.bot.isPublicChannel(channel as any)) return;
    if (!(channel as any).guild) return;

    await this.handleMessageRemove(channel, message.id);
  }

  // --- Alert message interactions (dismiss / delete / modmail / mute / ban) ---

  private async ackError(interaction: ButtonInteraction | AnySelectMenuInteraction, content: string): Promise<void> {
    const text = `❌ ${content}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text }).catch(() => {});
    } else {
      await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
    }
  }

  private async handleAlertInteraction(interaction: ButtonInteraction | AnySelectMenuInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    const data = this.getPersistentData(guild)!;
    const alertMessage: ReportedMessageData | undefined = data.AlertMessages?.[interaction.message.id];
    if (!alertMessage) return; // Not our job

    const moderator = interaction.member as GuildMember | null;
    if (!moderator) return;

    let actionStr: string | undefined;

    const customId = interaction.customId;
    if (customId === "alertmodule_dismiss") {
      if (!moderator.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await this.ackError(interaction, "You do not have permission to moderate");
        return;
      }

      if (alertMessage.Dismissed) {
        await interaction.reply({ content: "❎ Alert has already been dismissed", ephemeral: true }).catch(() => {});
        return;
      }

      alertMessage.Dismissed = true;
      // Disable dismiss button
      alertMessage.Components[1].components[0].disabled = true;

      await interaction
        .reply({ content: "✅ Alert has been dismissed (it won't trigger mute nor ping)", ephemeral: true })
        .catch(() => {});

      actionStr = `Dismissed by ${moderator.toString()}`;
    } else if (customId === "alertmodule_deletemessage") {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      if (!moderator.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await this.ackError(interaction, "You do not have permission to delete this message");
        return;
      }

      const channel = guild.channels.cache.get(alertMessage.ChannelId) as TextChannel | undefined;
      if (!channel) {
        await this.ackError(interaction, "failed to retrieve message channel");
        return;
      }

      const message = await channel.messages.fetch(alertMessage.MessageId).catch(() => undefined);
      if (!message) {
        await this.ackError(interaction, "failed to retrieve message");
        return;
      }

      try {
        await message.delete();
      } catch (e: any) {
        await this.ackError(interaction, `failed to delete message: ${e?.message ?? e}`);
        return;
      }

      await interaction.editReply({ content: "✅ the message was deleted" }).catch(() => {});

      actionStr = `Deleted by ${moderator.toString()}`;
    } else if (customId === "alertmodule_modmail") {
      const modmail = this.bot.getModuleForGuild(guild, "modmail") as any;
      if (!modmail) {
        await interaction
          .reply({ content: "❌ The modmail module isn't enabled on this server", ephemeral: true })
          .catch(() => {});
        return;
      }

      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      let targetMember: GuildMember | undefined;
      try {
        targetMember = guild.members.cache.get(alertMessage.ReportedUserId) ?? (await guild.members.fetch(alertMessage.ReportedUserId));
      } catch (e: any) {
        await this.ackError(interaction, `failed to retrieve member: ${e?.message ?? e}`);
        return;
      }

      if (!(await modmail.checkOpenTicketPermission?.(moderator, targetMember))) {
        await this.ackError(interaction, "You do not have permission to open a modmail ticket.");
        return;
      }

      const reason = `${moderator.toString()} has opened a ticket following your message (<https://discord.com/channels/${guild.id}/${alertMessage.ChannelId}/${alertMessage.MessageId}>)`;

      let ticketChannel: any;
      try {
        ticketChannel = await modmail.openTicket?.(moderator, targetMember, reason, true);
      } catch (e: any) {
        await this.ackError(interaction, `failed to open modmail ticket: ${e?.message ?? e}`);
        return;
      }
      if (!ticketChannel) {
        await this.ackError(interaction, "failed to open modmail ticket");
        return;
      }

      await interaction.editReply({ content: `✅ a modmail ticket has been created: ${ticketChannel.toString()}` }).catch(() => {});

      actionStr = `Modmail ticket opened by ${moderator.toString()}`;
    } else if (customId === "alertmodule_mute") {
      const mute = this.bot.getModuleForGuild(guild, "mute") as any;
      if (!mute) {
        await interaction
          .reply({ content: "❌ The mute module isn't enabled on this server", ephemeral: true })
          .catch(() => {});
        return;
      }

      const selectInteraction = interaction as AnySelectMenuInteraction;
      const rawValue = (selectInteraction.values ?? [])[0];
      const duration = rawValue !== undefined ? Number(rawValue) : undefined;
      if (duration === undefined || Number.isNaN(duration)) {
        await interaction.reply({ content: "❌ an error occurred (invalid duration)", ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      if (!(await mute.checkPermissions?.(moderator))) {
        await this.ackError(interaction, "You do not have permission mute this member");
        return;
      }

      try {
        await mute.mute?.(guild, alertMessage.ReportedUserId, duration);
      } catch (e: any) {
        await this.ackError(interaction, `failed to open mute member: ${e?.message ?? e}`);
        return;
      }

      await interaction.editReply({ content: `✅ the member has been muted for ${formatTime(duration)}` }).catch(() => {});

      actionStr = `Muted ${discordRelativeTime(duration)} by ${moderator.toString()}`;
    } else if (customId === "alertmodule_ban") {
      const selectInteraction = interaction as AnySelectMenuInteraction;
      const durationRaw = (selectInteraction.values ?? [])[0];

      const ban = this.bot.getModuleForGuild(guild, "ban") as any;
      // NOTE(port): lua checks the "mute" module's CheckPermissions here (not
      // "ban"'s) when a ban module is present — preserved verbatim.
      const mute = this.bot.getModuleForGuild(guild, "mute") as any;
      const hasPerm = ban
        ? await mute?.checkPermissions?.(moderator)
        : moderator.permissions.has(PermissionFlagsBits.BanMembers);
      if (!hasPerm) {
        await this.ackError(interaction, "You do not have permission mute this member");
        return;
      }

      if (durationRaw === "0" || durationRaw === "0_deletemessages") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const purgeSeconds = durationRaw === "0_deletemessages" ? 24 * 60 * 60 : 0;
        const reason = `banned by ${moderator.displayName} via alert`;

        try {
          await guild.members.ban(alertMessage.ReportedUserId, { reason, deleteMessageSeconds: purgeSeconds });
        } catch (e: any) {
          await this.ackError(interaction, `failed to open ban user: ${e?.message ?? e}`);
          return;
        }

        if (ban) {
          ban.registerBan?.(guild, alertMessage.ReportedUserId, moderator, 0, reason);
        }

        await interaction
          .editReply({ content: `✅ the member has been banned${purgeSeconds > 0 ? " (and its last 24h message deleted)" : ""}` })
          .catch(() => {});

        actionStr = `banned permanently by ${moderator.toString()}${purgeSeconds > 0 ? " (last 24h message deleted)" : ""}`;
      } else {
        const duration = durationRaw !== undefined ? Number(durationRaw) : undefined;
        if (duration === undefined || Number.isNaN(duration)) {
          await interaction.reply({ content: "❌ an error occurred (invalid duration)", ephemeral: true }).catch(() => {});
          return;
        }

        if (!ban) {
          await interaction
            .reply({
              content: "❌ The ban module isn't enabled on this server (and is required for temporary ban)",
              ephemeral: true,
            })
            .catch(() => {});
          return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const durationStr = formatTime(duration);
        // NOTE(port): lua references an out-of-scope `reason` local here (a bug —
        // it resolves to nil at runtime); using the actual ban reason instead.
        const reason = `banned by ${moderator.displayName} via alert for ${durationStr}`;

        try {
          await guild.members.ban(alertMessage.ReportedUserId, { reason });
        } catch (e: any) {
          await this.ackError(interaction, `failed to open ban user: ${e?.message ?? e}`);
          return;
        }

        ban.registerBan?.(guild, alertMessage.ReportedUserId, moderator, duration, reason);

        await interaction.editReply({ content: `✅ the member has been banned for ${durationStr}` }).catch(() => {});

        actionStr = `banned for ${durationStr} by ${moderator.toString()}`;
      }
    } else {
      await interaction
        .reply({ content: `❌ an error occurred (unknown interaction type ${String(customId)})` })
        .catch(() => {});
      return;
    }

    if (actionStr) {
      const currentActionStr = alertMessage.Embed.fields[4].value;
      alertMessage.Embed.fields[4].value = currentActionStr === "None" ? actionStr : `${currentActionStr}\n${actionStr}`;

      await interaction.message
        .edit({ components: alertMessage.Components, embeds: [alertMessage.Embed] })
        .catch(() => {});
    }
  }
}

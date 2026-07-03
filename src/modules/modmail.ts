// Ported from module_modmail.lua — lets members open a private "ticket" channel
// with staff (modmail), and lets staff open one-way moderation tickets. Tickets
// are closed via command, a 👋 reaction on the top message, or a button.

import {
  ChannelType,
  ComponentType,
  ButtonStyle,
  TextInputStyle,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  type Guild,
  type GuildMember,
  type TextChannel,
  type Message,
} from "discord.js";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Timer } from "../core/timer";
import { osTime, discordRelativeTime } from "../util/time";

/** Ported from utils.lua `util.MemberHasAnyRole` (no equivalent in core yet). */
function memberHasAnyRole(member: GuildMember, roleIds: string[] | undefined | null): boolean {
  if (!roleIds || roleIds.length === 0) return false;
  return roleIds.some((id) => member.roles.cache.has(id));
}

export default class ModmailModule extends BotModule {
  name = "modmail";

  private timer?: Timer;

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Category",
        Description: "Where should modmail channels be created",
        Type: ConfigType.Category,
        Default: "",
      },
      {
        Name: "ArchiveCategory",
        Description: "Category where modmail channels are moved to when closed",
        Type: ConfigType.Category,
        Optional: true,
      },
      {
        Name: "LogChannel",
        Description: "Where should modmail logs should be stored",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Array: true,
        Name: "TicketHandlingRoles",
        Description: "Roles allowed to close tickets (and force open them for members)",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Array: true,
        Name: "ForbiddenRoles",
        Description: "Roles that aren't allowed to open a ticket",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Array: true,
        Name: "AllowedRoles",
        Description: "Roles allowed to open tickets for them (if empty, everyone)",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "MaxConcurrentChannels",
        Description: "How many concurrents (active) channels can be created",
        Type: ConfigType.Integer,
        Default: 10,
      },
      {
        Name: "DeleteDuration",
        Description: "How many time does a ticket channel take to be deleted after being closed",
        Type: ConfigType.Duration,
        Default: 24 * 60 * 60,
      },
      {
        Name: "SaveTicketContent",
        Description: "Should the bot save every message in a modmail ticket when closing them? (up to 2000 messages)",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "MemberCloseOwnTickets",
        Description: "Should the bot allow members to close tickets them opened themselves?",
        Type: ConfigType.Boolean,
        Default: true,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.timer = this.bot.createRepeatTimer(1, -1, () => {
      const now = osTime();
      this.forEachGuild((_guildId, _config, _data, _persistentData, guild) => {
        if (!guild) return;
        const config = this.getConfig(guild)!;
        const deleteDuration = config.DeleteDuration;
        const data = this.getPersistentData(guild)!;

        const archiveData = data.archivedChannels?.[0];
        if (archiveData && now >= archiveData.closedAt + deleteDuration) {
          data.archivedChannels.shift();
          const channel = guild.channels.cache.get(archiveData.channelId);
          if (channel) channel.delete().catch(() => {});
        }
      });
    });

    this.registerCommand({
      Name: "newticket",
      Args: [
        { Name: "member", Type: ConfigType.Member, Optional: true, Description: "Member to open the ticket for" },
        { Name: "message", Type: ConfigType.String, Optional: true, Description: "Initial ticket message" },
      ],
      Help: "Allows you to contact the server staff in private",
      Silent: true,
      Func: async (ctx, targetMember: GuildMember | undefined, reason: string | undefined) => {
        const fromMember = ctx.member;
        if (!fromMember) return;

        const [authorized, err] = this.checkOpenTicketPermission(fromMember, targetMember);
        if (!authorized) return ctx.reply(err!);

        const [ticketChannel, openErr] = await this.openTicket(fromMember, targetMember ?? fromMember, reason, true);
        if (!ticketChannel) return ctx.reply(openErr!);
      },
    });

    this.registerCommand({
      Name: "modticket",
      Args: [
        { Name: "member", Type: ConfigType.Member, Description: "Member to open the ticket for" },
        { Name: "message", Type: ConfigType.String, Optional: true, Description: "Initial ticket message" },
      ],
      PrivilegeCheck: (member) => {
        if (!member) return false;
        const config = this.getConfig(member.guild);
        return !!config && memberHasAnyRole(member, config.TicketHandlingRoles);
      },
      Help: "Opens a moderation ticket for someone (same as newticket but doesn't allow the target user to talk)",
      Silent: true,
      Func: async (ctx, targetMember: GuildMember, reason: string | undefined) => {
        const [ticketChannel, err] = await this.openTicket(ctx.member!, targetMember, reason, false);
        if (!ticketChannel) return ctx.reply(err!);
      },
    });

    this.registerCommand({
      Name: "closeticket",
      Args: [{ Name: "reason", Type: ConfigType.String, Optional: true, Description: "Close reason" }],
      Help: "When used in a ticket channel, close it",
      Silent: true,
      Func: async (ctx, reason: string | undefined) => {
        const guild = ctx.guild;
        const member = ctx.member;
        if (!guild || !member || !ctx.channel) return;

        const ret = await this.handleTicketClose(member, reason, false, ctx.channel.id);
        if (ret === null) {
          await ctx.reply(this.bot.format(guild, "MODMAIL_NOTACTIVETICKET", member.toString()));
        } else if (ret === false) {
          await ctx.reply(this.bot.format(guild, "MODMAIL_NOTAUTHORIZED", member.toString()));
        }
      },
    });

    this.registerCommand({
      Name: "createticketform",
      Args: [{ Name: "channel", Type: ConfigType.Channel, Description: "Channel to post the ticket form button in" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Creates a button in the specified channel to open the ticket form",
      Silent: true,
      Func: async (ctx, channel: any) => {
        await channel.send({
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Primary,
                  custom_id: "modmail_openticketform",
                  label: this.bot.format(ctx.guild, "MODMAIL_OPENTICKET_BUTTON_LABEL"),
                },
              ],
            },
          ],
        });
      },
    });

    // --- Modern interaction handlers (buttons / modal) --------------------

    this.bot.interactions.registerComponent("modmail_closeticket", async (interaction) => {
      const guild = interaction.guild;
      if (!guild) return;
      const member = interaction.member as GuildMember | null;
      if (!member) return;

      await interaction.deferReply({ ephemeral: true });

      const ret = await this.handleTicketClose(member, undefined, true, interaction.message.id);
      if (ret === null) {
        await interaction.editReply({ content: this.bot.format(guild, "MODMAIL_NOTACTIVETICKET", member.toString()) });
      } else if (ret === false) {
        await interaction.editReply({ content: this.bot.format(guild, "MODMAIL_NOTAUTHORIZED", member.toString()) });
      } else {
        await interaction.editReply({
          content: this.bot.format(guild, "MODMAIL_TICKETCLOSED_CONFIRMATION", member.toString()),
        });
      }
    });

    this.bot.interactions.registerComponent("modmail_openticketform", async (interaction) => {
      const guild = interaction.guild;
      if (!guild) return;
      const member = interaction.member as GuildMember | null;
      if (!member) return;

      const [authorized, err] = this.checkOpenTicketPermission(member);
      if (!authorized) {
        await interaction.reply({ content: `❌ ${err}`, ephemeral: true }).catch(() => {});
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId("modmail_ticketform")
        .setTitle(this.bot.format(guild, "MODMAIL_FORM_TITLE"))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("form_desc")
              .setStyle(TextInputStyle.Paragraph)
              .setLabel(this.bot.format(guild, "MODMAIL_FORM_DESCRIPTION_LABEL"))
              .setRequired(true),
          ),
        );

      await (interaction as any).showModal(modal);
    });

    this.bot.interactions.registerModal("modmail_ticketform", async (interaction) => {
      const guild = interaction.guild;
      if (!guild) return;
      const fromMember = interaction.member as GuildMember | null;
      if (!fromMember) return;

      const [authorized, err] = this.checkOpenTicketPermission(fromMember);
      if (!authorized) {
        await interaction.reply({ content: `❌ ${err}`, ephemeral: true }).catch(() => {});
        return;
      }

      const reason = interaction.fields.getTextInputValue("form_desc");

      await interaction.deferReply({ ephemeral: true });

      const [ticketChannel, openErr] = await this.openTicket(fromMember, fromMember, reason, true);
      if (!ticketChannel) {
        await interaction.editReply({ content: `❌ ${openErr}` });
        return;
      }

      await interaction.editReply({
        content: this.bot.format(guild, "MODMAIL_TICKEDOPENED", ticketChannel.toString()),
      });
    });

    return true;
  }

  async onUnload(): Promise<void> {
    this.timer?.stop();
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;
    const modmailCategory = guild.channels.cache.get(config.Category);
    if (!modmailCategory || modmailCategory.type !== ChannelType.GuildCategory) {
      this.logWarning(guild, "Invalid modmail category (check your configuration)");
      return false;
    }

    const data = this.getPersistentData(guild)!;
    data.activeChannels = data.activeChannels ?? {};
    data.archivedChannels = data.archivedChannels ?? [];
    data.archivedChannels.sort((a: any, b: any) => a.closedAt - b.closedAt);

    return true;
  }

  // --- discord.js event hooks -------------------------------------------------

  async onGuildMemberRemove(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const data = this.getPersistentData(guild)!;
    const channelData = data.activeChannels?.[member.id];
    if (channelData) {
      const ticketChannel = guild.channels.cache.get(channelData.channelId) as TextChannel | undefined;
      if (ticketChannel) {
        await ticketChannel
          .send(this.bot.format(guild, "MODMAIL_LEFTSERVER", member.toString()))
          .catch(() => {});
      }
    }
  }

  async onChannelDelete(channel: any): Promise<void> {
    if (!this.bot.isPublicChannel(channel)) return;
    const guild = channel.guild;
    if (!guild) return;

    const data = this.getPersistentData(guild)!;
    for (const [userId, channelData] of Object.entries<any>(data.activeChannels ?? {})) {
      if (channelData.channelId === channel.id) {
        delete data.activeChannels[userId];
        break;
      }
    }
  }

  // discord.js v14 merges discordia's `OnReactionAdd`/`OnReactionAddUncached` into
  // a single `messageReactionAdd` event (partials are fetched on demand).
  async onMessageReactionAdd(reaction: any, user: any): Promise<void> {
    const message = reaction.message;
    if (!this.bot.isPublicChannel(message.channel)) return;

    const guild = message.guild;
    if (!guild) return;

    if (user.id === this.bot.client.user?.id) return;

    // Emoji data is present on the gateway payload even for partial reactions/messages
    // (only counts/users are incomplete), so no extra fetch is needed here — this
    // single handler covers both discordia's OnReactionAdd and OnReactionAddUncached.
    const reactionName: string | null = reaction.emoji?.name ?? null;

    await this.handleEmojiAdd(guild, user.id, message.id, reactionName);
  }

  // --- internal logic (ported 1:1 from the lua Module methods) ---------------

  private async handleEmojiAdd(guild: Guild, userId: string, refMessageId: string, reactionName: string | null) {
    if (reactionName !== "👋") return; // 👋

    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => undefined);
    if (!member) return;

    await this.handleTicketClose(member, undefined, true, refMessageId);
  }

  /**
   * reactionClose=true  -> refId is the top ticket message id (button / reaction close)
   * reactionClose=false -> refId is the ticket channel id (closeticket command)
   * Returns true on success, false if not authorized, null if no matching ticket found.
   */
  private async handleTicketClose(
    member: GuildMember,
    reason: string | undefined,
    reactionClose: boolean,
    refId: string,
  ): Promise<boolean | null> {
    const guild = member.guild;
    const config = this.getConfig(guild)!;
    const data = this.getPersistentData(guild)!;

    for (const [userId, channelData] of Object.entries<any>(data.activeChannels ?? {})) {
      const channelTest = reactionClose ? channelData.topMessageId === refId : channelData.channelId === refId;
      if (!channelTest) continue;

      let authorized = false;
      if (config.MemberCloseOwnTickets && channelData.openedByMember === member.id) {
        authorized = true;
      }

      if (!authorized && !memberHasAnyRole(member, config.TicketHandlingRoles)) {
        return false;
      }

      const ticketChannel = guild.channels.cache.get(channelData.channelId) as TextChannel | undefined;
      if (!ticketChannel) {
        delete data.activeChannels[userId];
        return true;
      }

      if (channelData.topMessageComponents) {
        const topMessage = await ticketChannel.messages.fetch(channelData.topMessageId).catch(() => undefined);
        if (topMessage) {
          // Disable "close ticket" button
          channelData.topMessageComponents[0].components[0].disabled = true;
          await topMessage.edit({ components: channelData.topMessageComponents }).catch(() => {});
        }
      }

      const closeMessage = this.bot.format(
        guild,
        "MODMAIL_TICKETCLOSE_MESSAGE",
        member.toString(),
        discordRelativeTime(config.DeleteDuration),
      );

      if (reason && reason.length > 0) {
        const author = member.user;
        await ticketChannel
          .send({
            content: closeMessage,
            embeds: [
              new EmbedBuilder()
                .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL() })
                .setDescription(reason)
                .setTimestamp(new Date()),
            ],
          })
          .catch(() => {});
      } else {
        await ticketChannel.send(closeMessage).catch(() => {});
      }

      await ticketChannel.setName(`${ticketChannel.name}✅`).catch(() => {});

      delete data.activeChannels[userId];

      if (config.ArchiveCategory && config.ArchiveCategory !== ticketChannel.id) {
        const archiveCategory = guild.channels.cache.get(config.ArchiveCategory);
        if (archiveCategory && archiveCategory.type === ChannelType.GuildCategory) {
          await ticketChannel.setParent(config.ArchiveCategory, { lockPermissions: false }).catch(() => {});
        }
      }

      const ticketMember = guild.members.cache.get(userId);
      if (ticketMember) {
        try {
          await ticketChannel.permissionOverwrites.edit(ticketMember, {
            ViewChannel: true,
            SendMessages: false,
          });
        } catch {
          await ticketChannel
            .send(`Failed to deny send messages permission to ${ticketMember.toString()}.`)
            .catch(() => {});
        }
      }

      if (config.LogChannel) {
        const logChannel = guild.channels.cache.get(config.LogChannel) as TextChannel | undefined;
        if (logChannel && logChannel.isTextBased()) {
          let author: { name: string; iconURL?: string } | undefined;
          if (ticketMember) {
            author = { name: ticketMember.user.tag, iconURL: ticketMember.user.displayAvatarURL() };
          }

          const fields: { name: string; value: string }[] = [];
          if (reason && reason.length > 0) {
            fields.push({ name: "Close message", value: reason });
          }

          let file: [string, string] | undefined;
          if (config.SaveTicketContent) {
            const [messages, fetchErr] = await this.fetchChannelMessages(ticketChannel, 2000);
            if (!messages) {
              fields.push({ name: "⚠️ Failed to save ticket content", value: `error: ${fetchErr}` });
            } else {
              file = ["messages.json", JSON.stringify(this.messagesToTable(messages), null, 1)];
              fields.push({ name: "📒 ticket content has been saved", value: "Check attachment file" });
            }
          }

          const embed = new EmbedBuilder()
            .setColor(16711680)
            .setDescription(`${member.toString()} has closed ticket ${ticketChannel.toString()}`)
            .setFooter({ text: `UserID: ${userId} | TicketID: ${ticketChannel.id}` })
            .setTimestamp(new Date());
          if (author) embed.setAuthor(author);
          if (fields.length > 0) embed.addFields(fields);

          try {
            const sendOptions: any = { embeds: [embed] };
            if (file) sendOptions.files = [new AttachmentBuilder(Buffer.from(file[1]), { name: file[0] })];
            await logChannel.send(sendOptions);
          } catch (e: any) {
            this.logError(guild, "Failed to post closing ticket message (%s)", e?.message ?? e);
          }
        }
      }

      data.archivedChannels.push({ channelId: ticketChannel.id, closedAt: osTime() });

      return true;
    }

    return null;
  }

  private checkOpenTicketPermission(
    fromMember: GuildMember,
    targetMember?: GuildMember,
  ): [true] | [false, string] {
    const guild = fromMember.guild;
    const config = this.getConfig(guild)!;

    if (memberHasAnyRole(fromMember, config.ForbiddenRoles)) {
      return [false, this.bot.format(guild, "MODMAIL_OPENTICKET_FORBIDDEN")];
    }

    if (targetMember && targetMember.id !== fromMember.id) {
      const authorized = memberHasAnyRole(fromMember, config.TicketHandlingRoles);
      if (!authorized) {
        return [false, this.bot.format(guild, "MODMAIL_OPENTICKET_NOTALLOWED_OTHERMEMBER")];
      }
    } else {
      const allowedRoles: string[] = config.AllowedRoles ?? [];
      if (allowedRoles.length > 0) {
        const authorized = memberHasAnyRole(fromMember, allowedRoles);
        if (!authorized) {
          return [false, this.bot.format(guild, "MODMAIL_OPENTICKET_NOTALLOWED")];
        }
      }
    }

    return [true];
  }

  private async openTicket(
    fromMember: GuildMember,
    targetMember: GuildMember,
    reason: string | undefined,
    twoWays: boolean,
  ): Promise<[TextChannel] | [undefined, string]> {
    const guild = fromMember.guild;
    const config = this.getConfig(guild)!;
    const data = this.getPersistentData(guild)!;

    if (data.activeChannels[targetMember.user.id]) {
      if (targetMember.id === fromMember.id) {
        return [undefined, `you already have an active ticket on this server, ${targetMember.user.toString()}.`];
      }
      return [undefined, `${targetMember.user.tag} already has an active ticket on this server.`];
    }

    if (config.MaxConcurrentChannels > 0 && Object.keys(data.activeChannels).length >= config.MaxConcurrentChannels) {
      return [
        undefined,
        `sorry ${fromMember.user.toString()}, but there are actually too many tickets open at the same time, please retry in a moment`,
      ];
    }

    const modmailCategory = guild.channels.cache.get(config.Category);
    if (!modmailCategory || modmailCategory.type !== ChannelType.GuildCategory) {
      return [undefined, "this server is not well configured, please tell the admins!"];
    }

    let filteredUsername = targetMember.user.username.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    if (filteredUsername.length === 0) filteredUsername = "empty";

    let ticketChannel: TextChannel;
    try {
      ticketChannel = (await guild.channels.create({
        name: `${filteredUsername}-${targetMember.user.discriminator}`,
        type: ChannelType.GuildText,
        parent: modmailCategory.id,
      })) as TextChannel;
    } catch (e: any) {
      this.logError(guild, "Failed to create modmail channel: %s", e?.message ?? e);
      return [undefined, "failed to create the channel, this is likely a bug."];
    }

    try {
      await ticketChannel.permissionOverwrites.edit(targetMember, {
        ViewChannel: true,
        SendMessages: twoWays,
      });
    } catch (e: any) {
      return [undefined, "failed to create the channel, this is likely a bug."];
    }

    if (config.LogChannel) {
      const logChannel = guild.channels.cache.get(config.LogChannel) as TextChannel | undefined;
      if (logChannel && logChannel.isTextBased()) {
        let color: number;
        let desc: string;
        if (fromMember.id === targetMember.id) {
          color = 61695;
          desc = `${targetMember.toString()} has opened a new ticket (${ticketChannel.toString()})`;
        } else if (twoWays) {
          color = 65280;
          desc = `${fromMember.toString()} has opened a new ticket for ${targetMember.toString()} (${ticketChannel.toString()})`;
        } else {
          color = 16776960;
          desc = `${fromMember.toString()} has opened a moderator ticket for ${targetMember.toString()} (${ticketChannel.toString()})`;
        }

        const fields: { name: string; value: string }[] = [];
        if (reason && reason.length > 0) fields.push({ name: "Ticket message", value: reason });

        const embed = new EmbedBuilder()
          .setAuthor({ name: targetMember.user.tag, iconURL: targetMember.user.displayAvatarURL() })
          .setColor(color)
          .setDescription(desc)
          .setFooter({ text: `UserID: ${targetMember.user.id} | TicketID: ${ticketChannel.id}` })
          .setTimestamp(new Date());
        if (fields.length > 0) embed.addFields(fields);

        try {
          await logChannel.send({ embeds: [embed] });
        } catch (e: any) {
          this.logError(guild, "Failed to post opening ticket message (%s)", e?.message ?? e);
        }
      }
    }

    const activeChannelData: any = {
      createdAt: osTime(),
      channelId: ticketChannel.id,
      targetMember: targetMember.id,
      openedByMember: fromMember.id,
    };

    data.activeChannels[targetMember.user.id] = activeChannelData;

    const message =
      fromMember.id === targetMember.id
        ? this.bot.format(guild, "MODMAIL_TICKETOPENING_MESSAGE", targetMember.toString(), guild.name)
        : this.bot.format(guild, "MODMAIL_TICKETOPENING_MESSAGE_MODERATION", targetMember.toString(), guild.name);

    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            custom_id: "modmail_closeticket",
            label: this.bot.format(guild, "MODMAIL_CLOSETICKET"),
            emoji: { name: "👋" },
          },
        ],
      },
    ];

    const topMessage = await ticketChannel.send({ content: message, components });
    await topMessage.pin().catch(() => {});

    activeChannelData.topMessageComponents = components;
    activeChannelData.topMessageId = topMessage.id;

    if (reason && reason.length > 0) {
      const author = fromMember.user;
      try {
        await ticketChannel.send({
          content: this.bot.format(guild, "MODMAIL_TICKETMESSAGE"),
          embeds: [
            new EmbedBuilder()
              .setAuthor({ name: author.tag, iconURL: author.displayAvatarURL() })
              .setDescription(reason)
              .setTimestamp(new Date()),
          ],
        });
      } catch (e: any) {
        this.logError(guild, "Failed to post reason message (%s)", e?.message ?? e);
      }
    }

    return [ticketChannel];
  }

  /**
   * Local stand-in for the lua `Bot:FetchChannelMessages` helper (not ported to
   * core yet). Paginates the channel history newest-first via the REST API, then
   * returns it oldest-first, up to `limit` messages.
   */
  private async fetchChannelMessages(channel: TextChannel, limit: number): Promise<[Message[]] | [undefined, string]> {
    try {
      const collected: Message[] = [];
      let beforeId: string | undefined;
      while (collected.length < limit) {
        const batchSize = Math.min(100, limit - collected.length);
        const batch = await channel.messages.fetch({ limit: batchSize, before: beforeId });
        if (batch.size === 0) break;
        collected.push(...batch.values());
        beforeId = batch.last()?.id;
        if (batch.size < batchSize) break;
      }
      collected.reverse();
      return [collected];
    } catch (e: any) {
      return [undefined, e?.message ?? String(e)];
    }
  }

  /** Local stand-in for the lua `bot:MessagesToTable` helper. */
  private messagesToTable(messages: Message[]): any[] {
    return messages.map((m) => ({
      id: m.id,
      authorId: m.author.id,
      authorTag: m.author.tag,
      bot: m.author.bot,
      content: m.content,
      timestamp: m.createdTimestamp,
      attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    }));
  }
}

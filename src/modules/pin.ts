// Ported from module_pin.lua — pins a message once it collects enough of a
// configured "trigger" emoji reaction, and exposes manual !pin / !unpin commands.
//
// Note on porting OnReactionAdd / OnReactionAddUncached: the Lua bot needed two
// separate hooks because discordia only delivered a full Reaction object when the
// message was already cached (OnReactionAdd), falling back to raw ids otherwise
// (OnReactionAddUncached, which had to re-fetch the message/reaction by hand).
// discord.js unifies both cases behind a single `MessageReactionAdd` event plus
// its `partial` flag/`.fetch()` mechanism (see src/core/client.ts's `partials`),
// so both Lua hooks are merged into the single `onMessageReactionAdd` below.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { EmbedBuilder, PermissionFlagsBits, type Message, type MessageReaction, type PartialMessageReaction, type User, type PartialUser } from "discord.js";

export default class PinModule extends BotModule {
  name = "pin";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Trigger",
        Description: "Triggering emoji",
        Type: ConfigType.Emoji,
        Default: "pushpin",
      },
      {
        Array: true,
        Name: "DisabledChannels",
        Description: "Channels where emoji pin is disabled",
        Type: ConfigType.Channel,
        Default: [],
      },
      {
        Name: "PinThreshold",
        Description: "How many pin emoji are required to pin a message",
        Type: ConfigType.Integer,
        Default: 10,
      },
      {
        Name: "AlertChannel",
        Description: "Channel where a message will be posted (if set) once a message is auto-pinned",
        Type: ConfigType.Channel,
        Optional: true,
      },
    ];
  }

  private async handleEmojiAdd(config: Record<string, any>, reaction: MessageReaction): Promise<void> {
    if ((reaction.count ?? 0) < config.PinThreshold) return;

    const message = reaction.message as Message;
    if (message.pinned) return;

    try {
      await message.pin();
    } catch {
      this.logError(message.guild, "Failed to pin message %s in channel %s", message.id, message.channelId);
      return;
    }

    if (config.AlertChannel) {
      const alertChannel = message.guild?.channels.cache.get(config.AlertChannel);
      if (!alertChannel || !("send" in alertChannel) || typeof (alertChannel as any).send !== "function") {
        this.logWarning(message.guild, "Invalid alert channel");
        return;
      }

      const author = message.author;
      let content = message.content ?? "";
      if (content.length > 1800) {
        content = content.slice(0, 1800) + "... <truncated>";
      }

      const embed = new EmbedBuilder()
        .setAuthor({ name: author.tag ?? author.username, iconURL: author.displayAvatarURL() })
        .setThumbnail(author.displayAvatarURL())
        .setFooter({ text: `in #${(message.channel as any).name ?? "?"} at ${message.guild?.name ?? "?"}` })
        .setTimestamp(message.createdTimestamp);
      if (content.length > 0) embed.setDescription(content);

      await (alertChannel as any)
        .send({
          content: `A message has been auto-pinned in ${message.channel.toString()}:\n${this.bot.generateMessageLink(message)}`,
          embeds: [embed],
        })
        .catch(() => {});
    }
  }

  async onMessageReactionAdd(
    reactionIn: MessageReaction | PartialMessageReaction,
    _user: User | PartialUser,
  ): Promise<void> {
    let reaction = reactionIn;

    const channel = reaction.message.channel;
    if (!this.bot.isPublicChannel(channel as any)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    if (!config) return;

    const idOrName = reaction.emoji.id ?? reaction.emoji.name;
    if (!idOrName) return;

    const emojiData = this.bot.getEmojiData(guild, idOrName);
    if (!emojiData) return;

    if (emojiData.name !== config.Trigger || (emojiData.custom && emojiData.fromGuild !== guild)) return;

    const disabledChannels: string[] = config.DisabledChannels ?? [];
    if (disabledChannels.includes(channel.id)) return;

    // Resolve partial reaction/message (equivalent of the Lua "uncached" path).
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return; // Maybe the reaction has been removed
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return; // Maybe the message has been deleted
      }
    }

    await this.handleEmojiAdd(config, reaction as MessageReaction);
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "pin",
      Args: [{ Name: "messageId", Type: ConfigType.Message, Description: "The link of the message to pin" }],
      Help: (guild) => this.bot.format(guild, "PIN_PIN_HELP"),
      Silent: true,
      Func: async (ctx, targetMessage: Message) => {
        const guild = ctx.guild;
        const sender = ctx.member;
        const senderId = sender?.id;
        const channelOwnerId = (ctx.channel as any)?.ownerId;

        if (targetMessage.pinned) return;

        if (!sender?.permissions.has(PermissionFlagsBits.ManageMessages) && senderId !== channelOwnerId) {
          return;
        }

        if (targetMessage.channel.id !== ctx.channel?.id) {
          await ctx.reply(this.bot.format(guild, "PIN_PIN_ERROR"));
          return;
        }

        try {
          await targetMessage.pin();
        } catch {
          await ctx.reply(this.bot.format(guild, "PIN_PIN_ERROR"));
        }
      },
    });

    this.registerCommand({
      Name: "unpin",
      Args: [{ Name: "messageId", Type: ConfigType.Message, Description: "The link of the message to unpin" }],
      Help: (guild) => this.bot.format(guild, "PIN_UNPIN_HELP"),
      Silent: true,
      Func: async (ctx, targetMessage: Message) => {
        const guild = ctx.guild;
        const sender = ctx.member;
        const senderId = sender?.id;
        const channelOwnerId = (ctx.channel as any)?.ownerId;

        if (!targetMessage.pinned) return;

        if (!sender?.permissions.has(PermissionFlagsBits.ManageMessages) && senderId !== channelOwnerId) {
          return;
        }

        if (targetMessage.channel.id !== ctx.channel?.id) {
          await ctx.reply(this.bot.format(guild, "PIN_UNPIN_ERROR"));
          return;
        }

        try {
          await targetMessage.unpin();
        } catch {
          await ctx.reply(this.bot.format(guild, "PIN_UNPIN_ERROR"));
        }
      },
    });

    return true;
  }
}

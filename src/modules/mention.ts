// Ported from module_mention.lua — reacts on messages that mention the bot
// (or @everyone/@here, if configured) with a configurable emoji.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { Guild, Message } from "discord.js";

export default class MentionModule extends BotModule {
  name = "mention";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Emoji",
        Description: "Emoji to add as a reaction",
        Type: ConfigType.Emoji,
        Default: "mention",
      },
      {
        Name: "ReactOnEveryoneOrHere",
        Description: "Reacts on everyone or here mention?",
        Type: ConfigType.Boolean,
        Default: true,
      },
    ];
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;
    const mentionEmoji = this.bot.getEmojiData(guild, config.Emoji);
    if (!mentionEmoji) {
      this.logWarning(guild, `Emoji "${config.Emoji}" not found (check your configuration)`);
      return false;
    }

    return true;
  }

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) {
      return;
    }

    let mention = false;
    const config = this.getConfig(message.guild!);
    if (!config) return;

    if (message.mentions.everyone && config.ReactOnEveryoneOrHere) {
      mention = true;
    } else {
      const selfId = this.bot.client.user?.id;
      if (selfId && message.mentions.users.has(selfId)) {
        mention = true;
      }
    }

    if (mention) {
      const mentionEmoji = this.bot.getEmojiData(message.guild, config.Emoji);
      if (!mentionEmoji) {
        return;
      }

      await message.react(mentionEmoji.emoji ?? mentionEmoji.id).catch(() => {});
    }
  }
}

// Ported from module_quote.lua — quotes a message (by in-channel id or by
// message link) into a rich embed, either via the `quote` command or
// automatically whenever someone posts a message link (AutoQuote).
//
// bot_utility.lua's `Bot:BuildQuoteEmbed` has no TypeScript equivalent yet in
// src/core/bot.ts, so it is reimplemented here as a private helper (see notes
// on the two lua bugs fixed below).

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { CommandContext } from "../core/command";
import { PermissionFlagsBits, StickerFormatType, type Message, type User } from "discord.js";

// Ported from bot_utility.lua's local `fileTypes` table.
const FILE_TYPES: Record<string, "image" | "sound" | "video"> = {
  aac: "sound",
  avi: "video",
  apng: "image",
  bmp: "image",
  flac: "video",
  gif: "image",
  ico: "image",
  jpg: "image",
  jpeg: "image",
  ogg: "sound",
  m4a: "sound",
  mkv: "video",
  mov: "video",
  mp1: "sound",
  mp2: "sound",
  mp3: "sound",
  mp4: "video",
  png: "image",
  tif: "image",
  wav: "sound",
  webm: "video",
  webp: "image",
  wma: "sound",
  wmv: "video",
};

interface QuoteItem {
  url: string;
  filename?: string;
  hasThumbnail?: boolean;
}

export default class QuoteModule extends BotModule {
  name = "quote";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "AutoQuote",
        Description: "Should quote messages when an user posts a message link (when not using quote command)",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "BigAvatar",
        Description: "Should quote messages include big avatars",
        Type: ConfigType.Boolean,
        Default: false,
      },
      {
        Name: "DeleteInvokationOnAutoQuote",
        Description: "Deletes the message that invoked the quote when auto-quoting",
        Type: ConfigType.Boolean,
        Default: false,
      },
      {
        Name: "DeleteInvokationOnManualQuote",
        Description: "Deletes the message that invoked the quote when quoting via command",
        Type: ConfigType.Boolean,
        Default: false,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "quote",
      Args: [
        { Name: "message", Type: ConfigType.String, Description: "Message id (in this channel) or message link" },
        { Name: "deleteInvokation", Type: ConfigType.Boolean, Optional: true, Description: "Delete the invoking message?" },
      ],
      Help: "Quote message",
      Func: async (ctx: CommandContext, messageArg: string, deleteInvokation?: boolean) => {
        const guild = ctx.guild;
        if (!guild) return;

        const messageIdMatch = String(messageArg).match(/^(\d+)$/);
        let quotedMessage: Message | undefined;
        let includesLink = false;
        const config = this.getConfig(guild)!;

        if (messageIdMatch) {
          const channel = ctx.channel as any;
          quotedMessage = channel ? await channel.messages.fetch(messageIdMatch[1]).catch(() => undefined) : undefined;
          if (!quotedMessage) {
            return ctx.reply("Message not found in this channel");
          }
          includesLink = true;
        } else {
          const [decoded, err] = await this.bot.decodeMessage(String(messageArg), false);
          if (!decoded) {
            return ctx.reply(`Invalid message link: ${err}`);
          }
          quotedMessage = decoded;

          // Checks if user has permission to see this message
          if (!(await this.checkReadPermission(ctx.author, quotedMessage))) {
            return ctx.reply("You can only quote messages you are able to see yourself");
          }
        }

        // Only delete the message that invoked the quote if no argument to the command is passed
        // and auto deletion is set true, or if command argument is specifically set to true
        const shouldDeleteInvokation =
          deleteInvokation === undefined ? !!config.DeleteInvokationOnManualQuote : !!deleteInvokation;

        await this.quoteMessage(ctx, quotedMessage, includesLink, shouldDeleteInvokation);
      },
    });

    return true;
  }

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) {
      return;
    }

    if (message.author.bot) {
      return;
    }

    if (message.content.startsWith(this.bot.config.prefix)) {
      return;
    }

    const guild = message.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    if (!config) return;

    if (config.AutoQuote) {
      const [quotedMessage] = await this.bot.decodeMessage(message.content, true);
      if (quotedMessage) {
        if (!(await this.checkReadPermission(message.author, quotedMessage))) {
          return;
        }

        await this.quoteMessage(message, quotedMessage, false, !!config.DeleteInvokationOnAutoQuote);
      }
    }
  }

  private async checkReadPermission(user: User, message: Message): Promise<boolean> {
    const quotedGuild = message.guild;
    if (!quotedGuild) return false;

    let member = quotedGuild.members.cache.get(user.id);
    if (!member) member = await quotedGuild.members.fetch(user.id).catch(() => undefined);
    if (!member) return false;

    const channel = message.channel;
    if (!channel) return false;

    try {
      if (!member.permissionsIn(channel as any).has(PermissionFlagsBits.ViewChannel)) {
        return false;
      }
    } catch {
      return false;
    }

    return true;
  }

  private async quoteMessage(
    triggering: CommandContext | Message,
    message: Message,
    includesLink: boolean,
    deleteInvokation: boolean,
  ): Promise<void> {
    const guild = triggering.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    if (!config) return;

    const embed: any = this.buildQuoteEmbed(message, { bigAvatar: !!config.BigAvatar });
    const channelName = "name" in message.channel ? (message.channel as any).name : "unknown";
    embed.footer = {
      text: `Quoted by ${triggering.author.tag} | in #${channelName} at ${message.guild?.name ?? "unknown"}`,
    };

    const payload = {
      content: includesLink ? `Message link: ${this.bot.generateMessageLink(message)}` : undefined,
      embeds: [embed],
    };

    if (triggering instanceof CommandContext) {
      if (deleteInvokation) {
        await triggering.send(payload);
        await triggering.delete();
      } else {
        await triggering.reply(payload);
      }
    } else {
      if (deleteInvokation) {
        await (triggering.channel as any).send(payload);
        await triggering.delete().catch(() => {});
      } else {
        await triggering.reply(payload);
      }
    }
  }

  // Ported from bot_utility.lua's Bot:BuildQuoteEmbed.
  //
  // NOTE(port): the original lua had `table.insert(t, image)` inside
  // ProcessAttachments, referencing an undefined global `image` instead of the
  // loop variable `attachment`. Combined with `message.attachments` always
  // being a (possibly empty) truthy table, this made the images/sounds/videos/
  // files buckets permanently empty and the embeds-fallback branch dead code —
  // i.e. the live bot currently never shows attachment images or file/link
  // lists when quoting. That looked like an unintentional bug rather than
  // deliberate behavior, so this port fixes it (uses the actual item, and
  // falls back to embeds only when there are no real attachments) so quoting
  // an image/file actually works. Flagged here for visibility.
  private buildQuoteEmbed(message: Message, opt: { bigAvatar?: boolean; initialContentSize?: number } = {}): any {
    const author = message.author;
    let content = message.content ?? "";

    const maxContentSizeBase = 1800 - (opt.initialContentSize ?? 0);

    const decorate = (embed: any) => {
      embed.author = { name: author.tag, icon_url: author.displayAvatarURL() };
      embed.thumbnail = opt.bigAvatar ? { url: author.displayAvatarURL({ size: 512 } as any) } : undefined;
      embed.timestamp = message.createdAt.toISOString();
      return embed;
    };

    // Quoting an embed? Copy it.
    if (content.length === 0 && message.attachments.size === 0 && message.embeds.length > 0) {
      const cloned = { ...(message.embeds[0].toJSON() as any) };
      return decorate(cloned);
    }

    let fields: { name: string; value: string; inline: boolean }[] | undefined;
    let imageUrl: string | undefined;

    const extractExt = (url: string): string => {
      const noQuery = url.split("?")[0];
      let ext = (noQuery.match(/\.([^./]+)$/)?.[1] ?? "").toLowerCase();
      // handle urls ending in .jpg:large
      ext = ext.match(/^([^:]+):/)?.[1] ?? ext;
      return ext;
    };

    const processItems = (items: QuoteItem[]) => {
      const images: QuoteItem[] = [];
      const sounds: QuoteItem[] = [];
      const videos: QuoteItem[] = [];
      const files: QuoteItem[] = [];

      for (const item of items) {
        let ext = extractExt(item.url);
        // Edge case for embed images with no extensions
        if (ext.length === 0 && item.hasThumbnail) ext = "png";

        const fileType = FILE_TYPES[ext];
        let bucket = files;
        if (fileType === "image") bucket = images;
        else if (fileType === "sound") bucket = sounds;
        else if (fileType === "video") bucket = videos;

        bucket.push(item);
      }

      // Special shortcut for one image attachment
      if (items.length === 1 && images.length === 1) {
        imageUrl = images[0].url;
      } else {
        fields = [];
        const linkList = (title: string, list: QuoteItem[]) => {
          if (list.length === 0) return;
          const desc = list.map((a) => (a.filename ? `[${a.filename}](${a.url})` : a.url));
          fields!.push({ name: title, value: desc.join("\n"), inline: true });
        };

        linkList("Images 🖼️", images);
        linkList("Sounds 🎵", sounds);
        linkList("Videos 🎥", videos);
        linkList("Files 🖥️", files);

        if (images.length > 0) {
          imageUrl = images[0].url;
        }
      }
    };

    if (message.attachments.size > 0) {
      processItems(
        [...message.attachments.values()].map((a) => ({ url: a.url, filename: a.name, hasThumbnail: !!a.height })),
      );
    } else if (message.embeds.length > 0) {
      processItems(
        message.embeds.map((e) => ({
          url: e.url ?? e.image?.url ?? e.thumbnail?.url ?? e.video?.url ?? "",
          hasThumbnail: !!(e.image || e.thumbnail),
        })),
      );
    }

    let maxContentSize = maxContentSizeBase;
    if (fields) {
      maxContentSize -= JSON.stringify(fields).length;
    }

    // Fix emojis: fall back to `:name:` text for custom emojis the bot can't use.
    content = this.fixupEmojis(content);

    if (content.length > maxContentSize) {
      content = content.slice(0, maxContentSize) + "... <truncated>";
    }

    // TODO(port): support multiple stickers (up to 3 per message); lua only
    // ever looked at the first one too.
    if (!imageUrl && message.stickers.size > 0) {
      const sticker = message.stickers.first()!;
      if (sticker.format !== StickerFormatType.Lottie) {
        imageUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=128`;
      }
    }

    return decorate({
      image: imageUrl ? { url: imageUrl } : undefined,
      description: content,
      fields,
    });
  }

  private fixupEmojis(content: string): string {
    return content.replace(/<a?:(\w+):(\d+)>/g, (mention: string, emojiName: string, emojiId: string) => {
      // Bots are allowed to use emojis from every server they are on.
      const emojiData = this.bot.getEmojiData(undefined, emojiId);

      let canUse = false;
      if (emojiData) {
        if (emojiData.custom) {
          const guildEmoji = emojiData.emoji;
          const fromGuild = emojiData.fromGuild;
          const botId = this.bot.client.user?.id;
          const botMember = botId && fromGuild ? fromGuild.members.cache.get(botId) : undefined;
          const requiredRoles: string[] = guildEmoji?.roles?.cache ? [...guildEmoji.roles.cache.keys()] : [];

          if (requiredRoles.length === 0) {
            canUse = true;
          } else if (botMember) {
            canUse = requiredRoles.some((r) => botMember!.roles.cache.has(r));
          } else {
            canUse = false;
          }
        } else {
          canUse = true;
        }
      }

      return canUse ? mention : `:${emojiName}:`;
    });
  }
}

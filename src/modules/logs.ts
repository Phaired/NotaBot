// Ported from module_logs.lua — logs channel management, nickname/username
// changes and deleted messages to per-guild configurable log channels. It also
// keeps a small per-channel message cache alive so that deleted messages can
// be "quoted" in the log.
//
// NOTE(port): the original relies on `Bot:BuildQuoteEmbed` / `Bot:FetchChannelMessages`
// from bot_utility.lua, which have not been ported to src/core yet. Per the
// porting rules (never touch core/other modules), faithful local
// re-implementations live at the bottom of this file instead.

import {
  ChannelType,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
  type TextChannel,
} from "discord.js";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";

/** Minimal shape shared by real attachments and "link-preview" embeds when classifying by extension. */
interface AttachmentLike {
  url: string;
  filename?: string;
  /** True when this entry came from an embed thumbnail rather than a real attachment (see bot_utility.lua). */
  isEmbedFallback?: boolean;
}

// Ported verbatim from bot_utility.lua's `fileTypes` table.
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

export default class LogsModule extends BotModule {
  name = "logs";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "ChannelManagementLogChannel",
        Description: "Where channel created/updated/deleted should be logged",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "DeletedMessageChannel",
        Description: "Where deleted messages should be logged",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "NicknameChangedLogChannel",
        Description: "Where nickname changes should be logged",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "IgnoredDeletedMessageChannels",
        Description: "Messages deleted in those channels will not be logged",
        Type: ConfigType.Channel,
        Array: true,
        Default: [],
      },
      {
        Global: true,
        Name: "PersistentMessageCacheSize",
        Description: "How many of the last messages of every text channel should stay in bot memory?",
        Type: ConfigType.Integer,
        Default: 50,
      },
    ];
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const data = this.getData(guild)!;

    // Keep a reference to the last X messages of every text channel.
    const messageCacheSize: number = this.globalConfig.PersistentMessageCacheSize ?? 50;
    data.cachedMessages = {};

    data.nicknames = {};
    data.usernames = {};
    for (const member of guild.members.cache.values()) {
      // Lua only stores a key when the nickname isn't nil (`t[k] = nil` removes the key);
      // mirror that so "no nickname yet" and "never tracked" compare the same way later.
      if (member.nickname != null) data.nicknames[member.id] = member.nickname;
      data.usernames[member.id] = member.user.username;
    }

    // Fire-and-forget cache warm-up, mirrors the lua `coroutine.wrap(function () ... end)()`.
    void (async () => {
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText) continue;
        try {
          data.cachedMessages[channel.id] = await this.fetchChannelMessages(channel as TextChannel, messageCacheSize);
        } catch {
          // lua's FetchChannelMessages error (2nd return value) was ignored here too.
        }
      }
    })();

    return true;
  }

  async onChannelDelete(channel: any): Promise<void> {
    const guild: Guild | undefined = channel?.guild;
    if (!guild) return;

    const data = this.getData(guild);
    if (data?.cachedMessages) delete data.cachedMessages[channel.id];

    const config = this.getConfig(guild);
    const channelManagementLogChannel = config?.ChannelManagementLogChannel;
    if (!channelManagementLogChannel) return;

    const logChannel = this.getLogChannel(guild, channelManagementLogChannel);
    if (!logChannel) {
      this.logWarning(guild, "Channel management log channel %s no longer exists", channelManagementLogChannel);
      return;
    }

    await logChannel
      .send({
        embeds: [
          {
            title: "Channel deleted",
            description: channel.name ?? String(channel.id),
            timestamp: new Date().toISOString(),
          },
        ],
      })
      .catch(() => {});
  }

  async onChannelCreate(channel: any): Promise<void> {
    const guild: Guild | undefined = channel?.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    const channelManagementLogChannel = config?.ChannelManagementLogChannel;
    if (!channelManagementLogChannel) return;

    const logChannel = this.getLogChannel(guild, channelManagementLogChannel);
    if (!logChannel) {
      this.logWarning(guild, "Channel management log channel %s no longer exists", channelManagementLogChannel);
      return;
    }

    await logChannel
      .send({
        embeds: [
          {
            title: "Channel created",
            description: typeof channel.toString === "function" ? channel.toString() : `<#${channel.id}>`,
            timestamp: new Date().toISOString(),
          },
        ],
      })
      .catch(() => {});
  }

  async onGuildMemberUpdate(_oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    const guild = newMember.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    const nicknameChangeLogChannel = config?.NicknameChangedLogChannel;
    if (!nicknameChangeLogChannel) return;

    const logChannel = this.getLogChannel(guild, nicknameChangeLogChannel);
    if (!logChannel) {
      // NOTE(port): lua reused the "Channel management" warning text here verbatim; preserved as-is.
      this.logWarning(guild, "Channel management log channel %s no longer exists", nicknameChangeLogChannel);
      return;
    }

    const data = this.getData(guild)!;
    if (!data.nicknames) data.nicknames = {};
    if (!data.usernames) data.usernames = {};

    // Ignore the first nickname/username change because new members tend to change it
    // directly after joining, which would otherwise generate a lot of useless logs.
    const cachedNickname = data.nicknames[newMember.id];
    if (cachedNickname != null && cachedNickname !== newMember.displayName) {
      await logChannel
        .send({
          embeds: [
            {
              title: "Nickname changed",
              description: `${newMember.toString()} - \`${cachedNickname}\` → \`${newMember.displayName}\``,
              timestamp: new Date().toISOString(),
            },
          ],
        })
        .catch(() => {});
    }

    const cachedUsername = data.usernames[newMember.id];
    if (cachedUsername != null && cachedUsername !== newMember.user.username) {
      await logChannel
        .send({
          embeds: [
            {
              title: "Username changed",
              description: `${newMember.toString()} - \`${cachedUsername}\` → \`${newMember.user.username}\``,
              timestamp: new Date().toISOString(),
            },
          ],
        })
        .catch(() => {});
    }

    data.nicknames[newMember.id] = newMember.displayName;
    data.usernames[newMember.id] = newMember.user.username;
  }

  // discord.js unifies discordia's OnMessageDelete / OnMessageDeleteUncached into a single
  // event whose `message` may be partial (author/content unavailable) when it wasn't cached.
  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    const guild = message.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    if (!config) return;

    const channelId = message.channelId;
    const ignoredChannels: string[] = config.IgnoredDeletedMessageChannels ?? [];
    if (ignoredChannels.includes(channelId)) return;

    const deletedMessageChannel = config.DeletedMessageChannel;
    if (!deletedMessageChannel) return;

    const logChannel = this.getLogChannel(guild, deletedMessageChannel);
    if (!logChannel) {
      this.logWarning(guild, "Deleted message log channel %s no longer exists", deletedMessageChannel);
      return;
    }

    const channel: any = message.channel;
    const channelMention = channel && typeof channel.toString === "function" ? channel.toString() : `<#${channelId}>`;

    if (!message.author) {
      // Uncached delete (lua's OnMessageDeleteUncached).
      await logChannel
        .send({
          embeds: [
            {
              description: `🗑️ **Deleted message (uncached) - sent by <unknown> in ${channelMention}**`,
              footer: { text: `Message ID: ${message.id}` },
              timestamp: new Date().toISOString(),
            },
          ],
        })
        .catch(() => {});
      return;
    }

    const desc = `🗑️ **Deleted message - sent by ${message.author.toString()} in ${channelMention}**\n`;
    const embed = this.buildQuoteEmbed(message as Message, guild, { initialContentSize: desc.length });
    embed.description = desc + (embed.description ?? "");
    embed.footer = { text: `Author ID: ${message.author.id} | Message ID: ${message.id}` };
    embed.timestamp = new Date().toISOString();

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  }

  async onMessageCreate(message: Message): Promise<void> {
    const guild = message.guild;
    if (!guild) return;

    const data = this.getData(guild)!;
    if (!data.cachedMessages) data.cachedMessages = {};

    let cachedMessages: Message[] = data.cachedMessages[message.channelId];
    if (!cachedMessages) {
      cachedMessages = [];
      data.cachedMessages[message.channelId] = cachedMessages;
    }

    // Remove oldest message from the cache and add the new message.
    cachedMessages.push(message);

    const messageCacheSize: number = this.globalConfig.PersistentMessageCacheSize ?? 50;
    while (cachedMessages.length > messageCacheSize) cachedMessages.shift();
  }

  // --- local helpers -----------------------------------------------------

  private getLogChannel(guild: Guild, channelId: string): GuildTextBasedChannel | null {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return channel as GuildTextBasedChannel;
  }

  /** Local re-implementation of bot_utility.lua's Bot:FetchChannelMessages(channel, nil, limit, true). */
  private async fetchChannelMessages(channel: TextChannel, limit: number): Promise<Message[]> {
    const seen = new Set<string>();
    const collected: Message[] = [];
    let before: string | undefined;
    let remaining = limit;

    while (remaining > 0) {
      const requestLimit = Math.min(remaining, 100);
      const batch = await channel.messages.fetch({ limit: requestLimit, before }).catch(() => undefined);
      if (!batch || batch.size === 0) break;

      for (const msg of batch.values()) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          collected.push(msg);
        }
      }

      before = batch.last()?.id;
      if (batch.size < requestLimit) break;
      remaining -= batch.size;
    }

    collected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return collected;
  }

  private extractExtension(url: string): string {
    const noQuery = url.split("?")[0];
    const m = noQuery.match(/\.([^./]+)$/);
    let ext = (m ? m[1] : "").toLowerCase();
    // handle urls ending in ".jpg:large"
    const colonIdx = ext.indexOf(":");
    if (colonIdx >= 0) ext = ext.slice(0, colonIdx);
    return ext;
  }

  /**
   * Local re-implementation of bot_utility.lua's Bot:BuildQuoteEmbed (not yet ported to core).
   * NOTE(port): the lua original had a latent bug in its attachment classification loop
   * (`table.insert(t, image)` referenced an undeclared global `image` instead of the loop's
   * `attachment`), which meant attachments were silently dropped from every quote embed. That
   * is fixed here (`attachment`/`item` is inserted correctly) since reproducing the typo would
   * make deleted-message logs always omit attachments, which isn't useful behavior to preserve.
   */
  private buildQuoteEmbed(
    message: Message,
    guild: Guild | null,
    opt: { initialContentSize?: number; bigAvatar?: boolean } = {},
  ): any {
    const author = message.author;
    let content = message.content ?? "";
    let maxContentSize = 1800 - (opt.initialContentSize ?? 0);

    const decorate = (embed: any) => {
      embed.author = { name: author.tag ?? author.username, icon_url: author.displayAvatarURL() };
      if (opt.bigAvatar) embed.thumbnail = { url: author.displayAvatarURL() };
      embed.timestamp = message.createdAt.toISOString();
      return embed;
    };

    // Quoting an embed-only message (no text, no attachments)? Copy it.
    if (content.length === 0 && message.attachments.size === 0 && message.embeds.length > 0) {
      const first: any = message.embeds[0];
      const plain = typeof first.toJSON === "function" ? first.toJSON() : { ...first };
      return decorate(plain);
    }

    let fields: { name: string; value: string; inline: boolean }[] | undefined;
    let imageUrl: string | undefined;

    const processAttachments = (items: AttachmentLike[]) => {
      const images: AttachmentLike[] = [];
      const sounds: AttachmentLike[] = [];
      const videos: AttachmentLike[] = [];
      const files: AttachmentLike[] = [];

      for (const item of items) {
        let ext = this.extractExtension(item.url);
        // Edge case for embed images with no extension.
        if (ext.length === 0 && item.isEmbedFallback) ext = "png";

        const fileType = FILE_TYPES[ext];
        let bucket = files;
        if (fileType === "image") bucket = images;
        else if (fileType === "sound") bucket = sounds;
        else if (fileType === "video") bucket = videos;
        bucket.push(item);
      }

      // Special shortcut for one image attachment.
      if (items.length === 1 && images.length === 1) {
        imageUrl = images[0].url;
      } else {
        fields = [];
        const linkList = (title: string, list: AttachmentLike[]) => {
          if (list.length === 0) return;
          const desc = list.map((a) => (a.filename ? `[${a.filename}](${a.url})` : a.url)).join("\n");
          fields!.push({ name: title, value: desc, inline: true });
        };

        linkList("Images 🖼️", images);
        linkList("Sounds 🎵", sounds);
        linkList("Videos 🎥", videos);
        linkList("Files 🖥️", files);

        if (images.length > 0) imageUrl = images[0].url;
      }
    };

    if (message.attachments.size > 0) {
      processAttachments(
        [...message.attachments.values()].map((a) => ({ url: a.url, filename: a.name ?? undefined })),
      );
    } else if (message.embeds.length > 0) {
      // Link-preview embeds (pasted image/media URLs) behave like attachments in the lua original.
      const items: AttachmentLike[] = [];
      for (const e of message.embeds as any[]) {
        const thumbUrl = e.thumbnail?.url ?? e.image?.url;
        if (e.url && thumbUrl) items.push({ url: e.url, isEmbedFallback: true });
      }
      if (items.length > 0) processAttachments(items);
    }

    if (fields) maxContentSize -= JSON.stringify(fields).length;

    // Downgrade custom emojis the bot doesn't actually have permission to use to plain `:name:` text.
    content = content.replace(/<a?:(\w+):(\d+)>/g, (mention: string, emojiName: string, emojiId: string) => {
      const emojiData: any = this.bot.getEmojiData(guild ?? undefined, emojiId);
      let canUse = false;
      if (emojiData) {
        if (emojiData.custom) {
          const fromGuild = emojiData.fromGuild;
          const botMember = fromGuild?.members.me;
          const roles = emojiData.emoji?.roles?.cache;
          if (botMember && roles && roles.size > 0) {
            canUse = roles.some((r: any) => botMember.roles.cache.has(r.id));
          } else {
            canUse = true;
          }
        } else {
          canUse = true;
        }
      }
      return canUse ? mention : `:${emojiName}:`;
    });

    if (content.length > maxContentSize) {
      content = content.slice(0, Math.max(0, maxContentSize)) + "... <truncated>";
    }

    if (!imageUrl) {
      const sticker: any = message.stickers?.first?.();
      // A sticker can be PNG (0? / actual enum values), APNG or LOTTIE (format 3); skip LOTTIE.
      if (sticker && sticker.format !== 3) {
        imageUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=128`;
      }
    }

    return decorate({
      image: imageUrl ? { url: imageUrl } : undefined,
      description: content,
      fields,
    });
  }
}

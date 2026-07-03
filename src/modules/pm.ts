// Ported from module_pm.lua — mirrors DMs sent to the bot into a log channel
// (`TargetChannel`) and lets staff reply from that channel (by replying to the
// mirrored log message) to relay an answer back to the user's DMs.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { ChannelType, MessageType, type Message, type Attachment } from "discord.js";

interface MirrorData {
  userId: string;
  messageId: string;
}

interface AuthorData {
  mirrorMessages: string[];
  lastMessageId?: string;
}

interface PmPersistentData {
  mirrors: Record<string, MirrorData>;
  users: Record<string, AuthorData>;
}

// Subset of bot_utility.lua's fileTypes table (extension -> bucket).
const FILE_TYPES: Record<string, "image" | "sound" | "video"> = {
  bmp: "image",
  gif: "image",
  jpeg: "image",
  jpg: "image",
  png: "image",
  tif: "image",
  webp: "image",
  mp1: "sound",
  mp2: "sound",
  mp3: "sound",
  wav: "sound",
  wma: "sound",
  avi: "video",
  mov: "video",
  mp4: "video",
  webm: "video",
  wmv: "video",
};

export default class PmModule extends BotModule {
  name = "pm";
  global = true;

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Global: true,
        Name: "TargetChannel",
        Description: "Where private messages should be logged",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Global: true,
        Array: true,
        Name: "BlockedUsers",
        Description: "Users who are not allowed to contact the bot",
        Type: ConfigType.User,
        Default: [],
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    const persistentData = this.getPersistentData() as PmPersistentData;
    if (!persistentData.mirrors) persistentData.mirrors = {};
    if (!persistentData.users) persistentData.users = {};

    return true;
  }

  async onMessageCreate(message: Message): Promise<void> {
    const channel = message.channel;
    if (!channel) return;

    if (message.author.bot) return;

    if (channel.type === ChannelType.DM) {
      await this.handlePrivateMessage(message);
    } else if (channel.id === this.globalConfig.TargetChannel) {
      await this.handleResponse(message);
    }
  }

  // Staff replying (in TargetChannel, to a mirrored message) to relay an answer to the user.
  private async handleResponse(message: Message): Promise<void> {
    const failure = async (text: string) => {
      await message
        .reply({ content: `❌ ${text}` })
        .catch(() => {});
    };

    if (message.type !== MessageType.Reply) {
      await failure("You must reply to a message so I know whom to send your message");
      return;
    }

    let mirrorMessage: Message | undefined;
    try {
      mirrorMessage = await message.fetchReference();
    } catch {
      mirrorMessage = undefined;
    }
    if (!mirrorMessage) {
      await failure("Failed to retrieve referenced message, maybe its too old?");
      return;
    }

    const mirrorMessageId = mirrorMessage.id;

    const persistentData = this.getPersistentData() as PmPersistentData;
    const mirrorData = persistentData.mirrors[mirrorMessageId];
    if (!mirrorData) {
      await failure("Failed to identify message, maybe its too old?");
      return;
    }

    let user = this.bot.client.users.cache.get(mirrorData.userId);
    if (!user) user = await this.bot.client.users.fetch(mirrorData.userId).catch(() => undefined);
    if (!user) {
      await failure("Failed to get user: unknown user (maybe this account was deleted?)");
      return;
    }

    let privateMessageChannel;
    try {
      privateMessageChannel = await user.createDM();
    } catch (err: any) {
      await failure(`Failed to get private channel: ${err?.message ?? err}`);
      return;
    }

    const authorData = persistentData.users[mirrorData.userId];
    if (!authorData) {
      await failure("An internal error occurred (no author data found)");
      return;
    }

    try {
      await privateMessageChannel.send({
        content: message.content,
        files: message.attachments.size > 0 ? [...message.attachments.values()] : undefined,
        // Only explicitly reply if we're answering another message than the last one.
        reply:
          authorData.lastMessageId !== mirrorData.messageId
            ? { messageReference: mirrorData.messageId }
            : undefined,
      });
    } catch (err: any) {
      await failure(`Failed to send reply to user: ${err?.message ?? err}`);
      return;
    }

    try {
      await message.react("✅");
    } catch (err: any) {
      this.logError(message.guild ?? null, "failed to add confirmation reaction to message: %s", err?.message ?? err);
    }
  }

  // A DM sent to the bot: mirror it into TargetChannel.
  private async handlePrivateMessage(message: Message): Promise<void> {
    if (!this.globalConfig.TargetChannel) return;

    const logChannel = this.bot.client.channels.cache.get(this.globalConfig.TargetChannel);
    if (!logChannel || !logChannel.isSendable()) {
      this.logError(null, "invalid target channel (%s)", this.globalConfig.TargetChannel);
      return;
    }

    const authorId = message.author.id;
    const blockedUsers: string[] = this.globalConfig.BlockedUsers ?? [];
    if (blockedUsers.includes(authorId)) {
      this.logInfo(null, "blocked a message from %s", message.author.tag ?? message.author.username);
      return;
    }

    const messageId = message.id;

    const embed = this.buildQuoteEmbed(message);
    embed.footer = { text: `Author ID: ${authorId} | Message ID: ${messageId}` };

    let mirrorMessage: Message;
    try {
      mirrorMessage = await logChannel.send({ embeds: [embed] });
    } catch (err: any) {
      this.logError(null, "failed to log private message: %s", err?.message ?? err);
      return;
    }

    const mirrorMessageId = mirrorMessage.id;

    const persistentData = this.getPersistentData() as PmPersistentData;
    persistentData.mirrors[mirrorMessageId] = {
      userId: authorId,
      messageId,
    };

    let authorData = persistentData.users[authorId];
    if (!authorData) {
      authorData = { mirrorMessages: [] };
      persistentData.users[authorId] = authorData;
    }

    authorData.lastMessageId = messageId;
    authorData.mirrorMessages.push(mirrorMessageId);

    // Keep only 100 previous message IDs per user (just in case)
    while (authorData.mirrorMessages.length > 100) {
      const oldMirrorMessageId = authorData.mirrorMessages.shift()!;
      delete persistentData.mirrors[oldMirrorMessageId];
    }
  }

  // TODO(port): reimplementation of Bot:BuildQuoteEmbed (bot_utility.lua) — that helper
  // hasn't been ported to core yet, so it's inlined here. Covers the common cases used by
  // this module (author/timestamp decoration, single-image shortcut, attachment link
  // fields, content truncation, and quoting a content-less embed) but does NOT replicate:
  //   - the cross-guild custom-emoji "can the bot use this emoji" downgrade, or
  //   - the (buggy, effectively dead in the original lua) embeds-as-attachments branch, or
  //   - sticker images.
  private buildQuoteEmbed(message: Message): any {
    const author = message.author;
    let content = message.content ?? "";
    const maxContentSize = 1800;

    // Quoting a message that's only an embed (no text, no attachments)? Copy it.
    if (content.length === 0 && message.attachments.size === 0 && message.embeds.length > 0) {
      const source: any = (message.embeds[0] as any).data ?? message.embeds[0];
      const copy: any = { ...source };
      copy.author = { name: author.tag ?? author.username, icon_url: author.displayAvatarURL() };
      copy.timestamp = message.createdAt.toISOString();
      return copy;
    }

    let imageUrl: string | undefined;
    let fields: { name: string; value: string; inline: boolean }[] | undefined;

    if (message.attachments.size > 0) {
      const attachments = [...message.attachments.values()];
      const images: Attachment[] = [];
      const sounds: Attachment[] = [];
      const videos: Attachment[] = [];
      const files: Attachment[] = [];

      for (const attachment of attachments) {
        const match = attachment.url.match(/\/[^/]+\.([^./?]+)(?:\?.*)?$/);
        let ext = (match?.[1] ?? "").toLowerCase();
        ext = ext.split(":")[0]; // handle urls ending in .jpg:large
        const kind = FILE_TYPES[ext];
        const bucket = kind === "image" ? images : kind === "sound" ? sounds : kind === "video" ? videos : files;
        bucket.push(attachment);
      }

      // Special shortcut for one image attachment.
      if (attachments.length === 1 && images.length === 1) {
        imageUrl = images[0].url;
      } else {
        fields = [];
        const linkList = (title: string, list: Attachment[]) => {
          if (list.length === 0) return;
          const desc = list.map((a) => (a.name ? `[${a.name}](${a.url})` : a.url)).join("\n");
          fields!.push({ name: title, value: desc, inline: true });
        };
        linkList("Images 🖼️", images);
        linkList("Sounds 🎵", sounds);
        linkList("Videos 🎥", videos);
        linkList("Files 🖥️", files);

        if (images.length > 0) imageUrl = images[0].url;
      }
    }

    if (content.length > maxContentSize) {
      content = content.slice(0, maxContentSize) + "... <truncated>";
    }

    return {
      author: { name: author.tag ?? author.username, icon_url: author.displayAvatarURL() },
      timestamp: message.createdAt.toISOString(),
      description: content,
      image: imageUrl ? { url: imageUrl } : undefined,
      fields,
    };
  }
}

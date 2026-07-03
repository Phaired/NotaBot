// Ported from bot_emoji.lua + data_emoji.lua.
//
// The original bot embeds a 774KB Lua table (data_emoji.lua) mapping unicode
// emoji names <-> codepoints. Rather than hand-port that, this subsystem loads an
// optional `data/emoji.json` (array of { names: string[], codes: string[] }); if
// absent it still resolves custom guild emoji and passes unicode through. A
// converter is provided in src/scripts/convertEmoji.ts.

import { readFileSync } from "fs";
import type { Client, Guild } from "discord.js";

export interface EmojiData {
  custom: boolean;
  id: string;
  name: string;
  mentionString: string;
  emoji?: any; // discord.js GuildEmoji when custom
  fromGuild?: Guild;
}

interface RawEmoji {
  names: string[];
  codes: string[];
}

export class EmojiRegistry {
  private byName = new Map<string, RawEmoji>();
  private byCode = new Map<string, RawEmoji>();
  private globalCache = new Map<string, EmojiData>();
  private guildCaches = new Map<string, Map<string, EmojiData>>();
  private globalGuildCache = new Map<string, EmojiData>();

  constructor(private client: Client, dataPath = "assets/emoji.json") {
    try {
      const raw = JSON.parse(readFileSync(dataPath, "utf8")) as RawEmoji[];
      for (const e of raw) {
        for (const n of e.names) this.byName.set(n, e);
        for (const c of e.codes) this.byCode.set(c, e);
      }
    } catch {
      // No emoji dataset available — custom + passthrough only.
    }
  }

  getEmojiData(guild: Guild | undefined | null, emojiIdOrName: string): EmojiData | null {
    const cached = this.globalCache.get(emojiIdOrName);
    if (cached) return cached;

    let emojiData: EmojiData | null = null;
    if (guild) {
      emojiData = this.guildCaches.get(guild.id)?.get(emojiIdOrName) ?? null;
    } else {
      emojiData = this.globalGuildCache.get(emojiIdOrName) ?? null;
    }
    if (emojiData) return emojiData;

    const discordEmoji = this.byCode.get(emojiIdOrName) ?? this.byName.get(emojiIdOrName);
    if (discordEmoji) {
      emojiData = {
        custom: false,
        id: discordEmoji.codes[0],
        name: discordEmoji.names[0],
        mentionString: discordEmoji.codes[0],
      };
    } else if (guild) {
      const emoji = guild.emojis.cache.find((e) => e.id === emojiIdOrName || e.name === emojiIdOrName);
      if (emoji) {
        emojiData = {
          custom: true,
          emoji,
          id: emoji.id,
          name: emoji.name ?? "",
          mentionString: emoji.toString(),
          fromGuild: guild,
        };
      }
    } else {
      for (const g of this.client.guilds.cache.values()) {
        const emoji = g.emojis.cache.find((e) => e.id === emojiIdOrName);
        if (emoji) {
          emojiData = {
            custom: true,
            emoji,
            id: emoji.id,
            name: emoji.name ?? "",
            mentionString: emoji.toString(),
            fromGuild: g,
          };
          break;
        }
      }
    }

    if (!emojiData) return null;

    if (emojiData.custom) {
      if (guild) {
        let cache = this.guildCaches.get(guild.id);
        if (!cache) {
          cache = new Map();
          this.guildCaches.set(guild.id, cache);
        }
        cache.set(emojiData.id, emojiData);
        cache.set(emojiData.name, emojiData);
      } else {
        this.globalGuildCache.set(emojiData.id, emojiData);
      }
    } else {
      this.globalCache.set(emojiData.id, emojiData);
      this.globalCache.set(emojiData.name, emojiData);
    }

    return emojiData;
  }

  invalidateGuild(guild: Guild) {
    this.guildCaches.delete(guild.id);
    for (const [k, v] of this.globalGuildCache) {
      if (v.fromGuild === guild) this.globalGuildCache.delete(k);
    }
  }
}

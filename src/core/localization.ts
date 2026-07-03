// Ported from bot_localization.lua. Loads localization tables from
// localization/<lang>.json (converted from the original localization/<lang>.lua).
// Format: { "Locs": { "KEY": "translation with %s" }, ... }
// Falls back to printf-formatting the key itself when no translation exists.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Guild } from "discord.js";
import { sprintf } from "./logger";
import { formatTime } from "../util/time";
import type { Bot } from "./bot";

interface LangTable {
  Locs: Record<string, string>;
}

export class Localization {
  private tables = new Map<string, LangTable>();

  constructor(private bot: Bot, dir = "localization") {
    try {
      for (const file of readdirSync(dir)) {
        const m = file.match(/(\w+)\.json$/);
        if (!m) continue;
        try {
          this.tables.set(m[1], JSON.parse(readFileSync(join(dir, file), "utf8")));
        } catch (e: any) {
          console.error(`failed to load language data from ${file}: ${e?.message ?? e}`);
        }
      }
    } catch {
      // No localization directory — English passthrough only.
    }
  }

  private languageFor(guild?: Guild | null): string {
    if (!guild) return "en";
    const serverconfig = this.bot.getModuleForGuild(guild, "serverconfig");
    const config = serverconfig?.getConfig?.(guild);
    return config?.Language ?? "en";
  }

  format(guild: Guild | undefined | null, key: string, ...args: any[]): string {
    const table = this.tables.get(this.languageFor(guild));
    const translation = table?.Locs?.[key];
    return sprintf(translation ?? key, args);
  }

  formatDuration(guild: Guild | undefined | null, seconds: number, depth?: number): string {
    // Language-specific FormatTime tables aren't ported; use the English formatter.
    return formatTime(seconds, depth);
  }
}

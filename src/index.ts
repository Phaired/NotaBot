// Entry point — the TypeScript equivalent of bot.lua's bootstrap sequence.

import { readdirSync } from "fs";
import { join } from "path";
import { Events } from "discord.js";
import { loadConfig } from "./config";
import { createClient } from "./core/client";
import { Bot } from "./core/bot";
import { registerBuiltinCommands } from "./commands/builtin";
import { installCommandDispatch } from "./core/commandDispatcher";
import { installModuleEventDispatch } from "./core/events";
import { registerModule, onClientReady } from "./core/moduleLoader";
import { registerSlashCommands } from "./core/slashRegistry";
import { BotModule } from "./core/module";
import { logger } from "./core/logger";

async function loadAllModules(bot: Bot) {
  const dir = join(__dirname, "modules");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    logger.warning("No modules directory found");
    return;
  }

  for (const file of files) {
    if (!/\.(ts|js)$/.test(file)) continue;
    if (file.endsWith(".d.ts")) continue;
    if (file.startsWith("_")) continue; // _template.ts and helpers

    try {
      const mod = require(join(dir, file));
      const ModuleClass = mod.default ?? mod[Object.keys(mod)[0]];
      if (typeof ModuleClass !== "function") continue;
      const instance: BotModule = new ModuleClass();
      if (!(instance instanceof BotModule)) continue;
      await registerModule(bot, instance);
    } catch (e: any) {
      logger.error("Failed to load module %s: %s", file, e?.stack ?? e);
    }
  }
}

async function main() {
  const config = loadConfig();
  const client = createClient();
  const bot = new Bot(client, config);
  bot.init();

  registerBuiltinCommands(bot);
  installCommandDispatch(bot);
  installModuleEventDispatch(bot);

  await loadAllModules(bot);

  client.once(Events.ClientReady, async () => {
    logger.info("Logged in as %s", client.user?.tag);
    await onClientReady(bot);
    await registerSlashCommands(bot);
    bot.createRepeatTimer(5 * 60, -1, () => bot.save());
    logger.info("Bot ready — %s commands, %s modules", bot.commands.size, bot.modules.size);
  });

  client.on(Events.GuildAvailable, (guild) =>
    logger.info("Guild %s (%s members)", guild.name, guild.memberCount),
  );

  // Emoji cache invalidation (bot_emoji.lua).
  const invalidate = (guild: any) => bot.emoji.invalidateGuild(guild);
  client.on(Events.GuildEmojiUpdate, (e) => e.guild && invalidate(e.guild));
  client.on(Events.GuildEmojiCreate, (e) => e.guild && invalidate(e.guild));
  client.on(Events.GuildEmojiDelete, (e) => e.guild && invalidate(e.guild));
  client.on(Events.GuildDelete, invalidate);

  await client.login(config.token);
}

main().catch((e) => {
  logger.error("Fatal error: %s", e?.stack ?? e);
  process.exit(1);
});

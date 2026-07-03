// Standalone slash-command deploy script: `pnpm deploy-commands`.
// Loads all modules just to collect their command definitions, then registers
// the slash commands without actually logging the gateway in.

import { readdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { createClient } from "../core/client";
import { Bot } from "../core/bot";
import { registerBuiltinCommands } from "../commands/builtin";
import { registerModule } from "../core/moduleLoader";
import { buildSlashCommands } from "../core/slashRegistry";
import { BotModule } from "../core/module";
import { REST, Routes } from "discord.js";
import { logger } from "../core/logger";

async function main() {
  const config = loadConfig();
  const bot = new Bot(createClient(), config);
  bot.init();
  registerBuiltinCommands(bot);

  const dir = join(__dirname, "..", "modules");
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|js)$/.test(file) || file.endsWith(".d.ts") || file.startsWith("_")) continue;
    try {
      const mod = require(join(dir, file));
      const ModuleClass = mod.default ?? mod[Object.keys(mod)[0]];
      const instance: BotModule = new ModuleClass();
      if (instance instanceof BotModule) await registerModule(bot, instance);
    } catch (e: any) {
      logger.warning("Skipping module %s: %s", file, e?.message ?? e);
    }
  }

  const commands = buildSlashCommands(bot);
  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
    : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: commands });
  logger.info("Deployed %s slash commands", commands.length);
  process.exit(0);
}

main().catch((e) => {
  logger.error("Deploy failed: %s", e?.stack ?? e);
  process.exit(1);
});

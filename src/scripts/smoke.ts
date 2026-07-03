// Boot smoke test: instantiate every module (runs getConfigTable + onLoaded),
// register built-in commands, and build the slash-command payload — WITHOUT
// logging into Discord. Reports per-module load failures. Exits non-zero on any.

process.env.DISCORD_TOKEN ||= "smoke-test-dummy-token";

import { readdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { createClient } from "../core/client";
import { Bot } from "../core/bot";
import { registerBuiltinCommands } from "../commands/builtin";
import { registerModule } from "../core/moduleLoader";
import { buildSlashCommands } from "../core/slashRegistry";
import { BotModule } from "../core/module";

async function main() {
  const bot = new Bot(createClient(), loadConfig());
  bot.init();
  registerBuiltinCommands(bot);
  const builtinCount = bot.commands.size;

  const dir = join(__dirname, "..", "modules");
  const failures: { file: string; error: string }[] = [];
  let loaded = 0;

  for (const file of readdirSync(dir)) {
    if (!/\.ts$/.test(file) || file.endsWith(".d.ts") || file.startsWith("_")) continue;
    try {
      const mod = require(join(dir, file));
      const ModuleClass = mod.default ?? mod[Object.keys(mod)[0]];
      const instance: BotModule = new ModuleClass();
      if (!(instance instanceof BotModule)) throw new Error("not a BotModule");
      await registerModule(bot, instance);
      loaded++;
    } catch (e: any) {
      failures.push({ file, error: e?.message ?? String(e) });
    }
  }

  let slashCount = 0;
  let slashError: string | undefined;
  try {
    slashCount = buildSlashCommands(bot).length;
  } catch (e: any) {
    slashError = e?.message ?? String(e);
  }

  console.log("\n===== SMOKE TEST =====");
  console.log(`Built-in commands: ${builtinCount}`);
  console.log(`Modules loaded:    ${loaded}`);
  console.log(`Total commands:    ${bot.commands.size}`);
  console.log(`Slash payload:     ${slashError ? "ERROR: " + slashError : slashCount + " commands"}`);
  if (failures.length) {
    console.log(`\nFAILED MODULES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f.file}: ${f.error}`);
  } else {
    console.log("\nAll modules loaded successfully. ✅");
  }
  console.log("======================\n");

  process.exit(failures.length > 0 || slashError ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e?.stack ?? e);
  process.exit(1);
});

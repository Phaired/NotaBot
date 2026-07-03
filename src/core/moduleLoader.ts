// Module registration/bootstrap — the runtime side of bot_modules.lua's
// LoadModule / MakeModuleReady / CallOnReady.

import type { Bot } from "./bot";
import type { BotModule, ConfigDefinition } from "./module";
import { logger } from "./logger";

/** Validate + normalize a module's config table, splitting global vs guild defs. */
function processConfigTable(mod: BotModule) {
  const globalDefs: ConfigDefinition[] = [];
  const guildDefs: ConfigDefinition[] = [];

  if (mod.getConfigTable) {
    const defs = mod.getConfigTable();
    if (!Array.isArray(defs)) throw new Error(`Module ${mod.name}: getConfigTable() must return an array`);
    for (const def of defs) {
      if (!def.Name) throw new Error(`Module ${mod.name}: a config option is missing "Name"`);
      if (!def.Description) throw new Error(`Module ${mod.name}: config "${def.Name}" is missing "Description"`);
      if (def.Type === undefined) throw new Error(`Module ${mod.name}: config "${def.Name}" is missing "Type"`);
      def.Array ??= false;
      def.Global ??= false;
      def.Optional ??= false;
      def.Sensitive ??= false;
      if (def.Default === undefined && !def.Optional) {
        throw new Error(`Module ${mod.name}: config "${def.Name}" is not optional and has no default`);
      }
      (def.Global ? globalDefs : guildDefs).push(def);
    }
  }

  mod._globalConfigDefs = globalDefs;
  mod._guildConfigDefs = guildDefs;
}

export async function registerModule(bot: Bot, mod: BotModule): Promise<BotModule> {
  // Replace an existing instance with the same name.
  if (bot.modules.has(mod.name)) await unloadModule(bot, mod.name);

  mod.bot = bot;
  mod._commands = [];
  processConfigTable(mod);

  await mod.loadModuleData();
  mod._prepareGlobalConfig();

  bot.modules.set(mod.name, mod);

  if (mod.onLoaded) {
    const ok = await mod.onLoaded();
    if (!ok) {
      bot.modules.delete(mod.name);
      throw new Error(`Module ${mod.name}: onLoaded hook returned false`);
    }
  }

  logger.info("[<*>][%s] Loaded module", mod.name);

  if (bot.isReady) {
    if (mod.onReady) await mod.onReady();
    await makeModuleReady(mod);
  }

  return mod;
}

export async function unloadModule(bot: Bot, moduleName: string): Promise<boolean> {
  const mod = bot.modules.get(moduleName);
  if (!mod) return false;

  const enabledGuilds: any[] = [];
  mod.forEachGuild((_id, _c, _d, _p, guild) => guild && enabledGuilds.push(guild), false, true);
  for (const guild of enabledGuilds) await mod.disableForGuild(guild, true);

  if (bot.isReady && mod.onUnload) await mod.onUnload();
  await mod.savePersistentData();

  for (const commandName of mod._commands) bot.unregisterCommand(commandName);

  bot.modules.delete(moduleName);
  logger.info("[<*>][%s] Unloaded module", moduleName);
  return true;
}

/** Enable modules for guilds that were persisted as enabled. */
export async function makeModuleReady(mod: BotModule) {
  const guilds: any[] = [];
  mod.forEachGuild((_id, _c, _d, _p, guild) => guild && guilds.push(guild), false, true);
  for (const guild of guilds) await mod.enableForGuild(guild, true, true);
}

/** Called on the client `ready` event. */
export async function onClientReady(bot: Bot) {
  for (const mod of bot.modules.values()) {
    if (mod.onReady) await Promise.resolve(mod.onReady()).catch((e) => logger.warning("onReady failed: %s", e));
    if (!bot.isReady) await makeModuleReady(mod);
  }
  bot.isReady = true;
}

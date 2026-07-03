// Base class for all feature modules — the TypeScript equivalent of the Lua
// `Module` table + ModuleMetatable (bot_modules.lua).
//
// Porting a module_xxx.lua means writing:
//
//   export default class MyModule extends BotModule {
//     name = "xxx";
//     getConfigTable() { return [ ... ]; }
//     async onLoaded() { this.registerCommand({ ... }); return true; }
//     async onMessageCreate(message) { ... }   // optional discord.js event hooks
//   }
//
// Lifecycle hooks (all optional): onLoaded, onUnload, onEnable, onDisable, onReady.
// Event hooks are named after discord.js events (see FRAMEWORK.md for the mapping).

import type { Guild } from "discord.js";
import type { Bot } from "./bot";
import type { CommandDefinition } from "./command";
import { ConfigType, type ParseResult } from "./configTypes";
import { serializeToFile, unserializeFromFile, scanDir } from "./storage";
import { logger } from "./logger";

export interface ConfigDefinition {
  Name: string;
  Description: string;
  Type: ConfigType;
  Default?: any;
  Array?: boolean;
  ArrayMaxSize?: number;
  Global?: boolean;
  Optional?: boolean;
  Sensitive?: boolean;
  ValidateValue?: (value: any, configTable: ConfigDefinition) => ParseResult<boolean>;
  ValidateConfig?: (value: any, configTable: ConfigDefinition, guildId?: string) => ParseResult<boolean>;
}

export interface GuildData {
  Config: Record<string, any> & { _Enabled: boolean };
  Data: Record<string, any>;
  PersistentData: Record<string, any>;
  _Ready: boolean;
}

export abstract class BotModule {
  abstract name: string;
  /** Global modules are always enabled and can't be toggled per guild. */
  global = false;

  bot!: Bot;

  globalConfig: Record<string, any> = {};
  globalPersistentData: Record<string, any> = {};

  _globalConfigDefs: ConfigDefinition[] = [];
  _guildConfigDefs: ConfigDefinition[] = [];
  _commands: string[] = [];
  _guilds = new Map<string, GuildData>();

  // Optional hooks — override in subclasses.
  getConfigTable?(): ConfigDefinition[];
  onLoaded?(): boolean | Promise<boolean>;
  onUnload?(): void | Promise<void>;
  onEnable?(guild: Guild): boolean | Promise<boolean>;
  onDisable?(guild: Guild): void | Promise<void>;
  onReady?(): void | Promise<void>;

  /** Called when a config value changes; override to react. */
  handleConfigUpdate(_guild: Guild | null, _config: Record<string, any>, _configName: string | null): void {}

  // --- Command registration --------------------------------------------------

  registerCommand(values: CommandDefinition) {
    const originalCheck = values.PrivilegeCheck;
    values.PrivilegeCheck = async (member) => {
      if (!member || !this.isEnabledForGuild(member.guild)) return false;
      return originalCheck ? originalCheck(member) : true;
    };
    this._commands.push(values.Name);
    return this.bot.registerCommand(values);
  }

  // --- Enable / disable ------------------------------------------------------

  isEnabledForGuild(guild: Guild | null | undefined): boolean {
    if (this.global) return true;
    if (!guild) return false;
    const config = this.getConfig(guild, true);
    return config?._Enabled ?? false;
  }

  async enableForGuild(guild: Guild, ignoreCheck = false, dontSave = false): Promise<{ ok: boolean; err?: string }> {
    if (!ignoreCheck && this.isEnabledForGuild(guild)) return { ok: true };

    if (this.onEnable) {
      const ret = await this.onEnable(guild);
      if (!ret) return { ok: false, err: "onEnable hook returned false" };
    }

    const data = this.getGuildData(guild.id)!;
    data._Ready = true;
    data.Config._Enabled = true;

    if (!dontSave) await this.save(guild);
    this.logInfo(guild, "Module enabled");
    return { ok: true };
  }

  async disableForGuild(guild: Guild, dontSave = false): Promise<{ ok: boolean; err?: string }> {
    if (!this.isEnabledForGuild(guild)) return { ok: true };

    if (this.onDisable) await this.onDisable(guild);

    const config = this.getConfig(guild)!;
    config._Enabled = false;
    if (!dontSave) await this.saveGuildConfig(guild);

    this.logInfo(guild, "Module disabled");
    return { ok: true };
  }

  // --- Config / data access --------------------------------------------------

  getGuildData(guildId: string, noCreate = false): GuildData | null {
    let data = this._guilds.get(guildId);
    if (!data && !noCreate) {
      data = {
        Config: { _Enabled: false },
        Data: {},
        PersistentData: {},
        _Ready: false,
      };
      this._prepareGuildConfig(guildId, data.Config);
      this._guilds.set(guildId, data);
    }
    return data ?? null;
  }

  getConfig(guild: Guild, noCreate = false): (Record<string, any> & { _Enabled: boolean }) | null {
    return this.getGuildData(guild.id, noCreate)?.Config ?? null;
  }

  getData(guild: Guild, noCreate = false): Record<string, any> | null {
    return this.getGuildData(guild.id, noCreate)?.Data ?? null;
  }

  getPersistentData(guild?: Guild | null, noCreate = false): Record<string, any> | null {
    if (!guild) return this.globalPersistentData;
    return this.getGuildData(guild.id, noCreate)?.PersistentData ?? null;
  }

  forEachGuild(
    callback: (
      guildId: string,
      config: Record<string, any>,
      data: Record<string, any>,
      persistentData: Record<string, any>,
      guild: Guild | undefined,
    ) => void,
    evenDisabled = false,
    evenNonReady = false,
    evenNonLoaded = false,
  ) {
    for (const [guildId, data] of this._guilds) {
      const guild = this.bot.client.guilds.cache.get(guildId);
      if (
        (guild || evenNonLoaded) &&
        (evenNonReady || data._Ready) &&
        (evenDisabled || data.Config._Enabled)
      ) {
        callback(guildId, data.Config, data.Data, data.PersistentData, guild);
      }
    }
  }

  // --- Logging ---------------------------------------------------------------

  private log(level: "info" | "warning" | "error", guild: Guild | string | null, fmt: string, ...args: any[]) {
    const name = typeof guild === "string" ? "<*>" : guild?.name ?? "<Invalid guild>";
    const message = typeof guild === "string" ? guild : fmt;
    const rest = typeof guild === "string" ? [fmt, ...args] : args;
    logger[level]("[%s][%s] " + message, name, this.name, ...rest);
  }
  logInfo(guild: Guild | string | null, fmt: string, ...args: any[]) {
    this.log("info", guild, fmt, ...args);
  }
  logWarning(guild: Guild | string | null, fmt: string, ...args: any[]) {
    this.log("warning", guild, fmt, ...args);
  }
  logError(guild: Guild | string | null, fmt: string, ...args: any[]) {
    this.log("error", guild, fmt, ...args);
  }

  // --- Config validation / preparation --------------------------------------

  private validateConfigType(configTable: ConfigDefinition, value: any, guildId?: string): ParseResult<boolean> {
    const validator = this.bot.configTypes.validate[configTable.Type];
    if (configTable.Array) {
      if (!Array.isArray(value)) return [undefined, `expected an array, got ${typeof value}`];
      if (configTable.ArrayMaxSize && value.length > configTable.ArrayMaxSize) {
        return [undefined, `${value.length} values found but only up to ${configTable.ArrayMaxSize} allowed`];
      }
      for (const v of value) {
        const [okv, err] = validator(v);
        if (!okv) return [undefined, err!];
        if (configTable.ValidateValue) {
          const [okv2, err2] = configTable.ValidateValue(v, configTable);
          if (!okv2) return [undefined, err2!];
        }
      }
    } else {
      const [okv, err] = validator(value);
      if (!okv) return [undefined, err!];
      if (configTable.ValidateValue) {
        const [okv2, err2] = configTable.ValidateValue(value, configTable);
        if (!okv2) return [undefined, err2!];
      }
    }
    if (configTable.ValidateConfig) {
      const [okv, err] = configTable.ValidateConfig(value, configTable, guildId);
      if (!okv) return [undefined, err!];
    }
    return [true];
  }

  private prepareConfig(context: string, defs: ConfigDefinition[], values: Record<string, any>, guildId?: string) {
    for (const def of defs) {
      let reset = false;
      const value = values[def.Name];
      if (value === undefined || value === null) {
        reset = true;
      } else {
        const [okv, err] = this.validateConfigType(def, value, guildId);
        if (!okv) {
          this.logWarning(null, "%s has invalid value for option %s (%s), resetting...", context, def.Name, err ?? "?");
          reset = true;
        }
      }
      if (reset) {
        values[def.Name] = def.Default !== undefined ? deepCopy(def.Default) : undefined;
      }
    }
  }

  _prepareGlobalConfig() {
    if (!this.globalConfig) this.globalConfig = {};
    this.prepareConfig("Global config", this._globalConfigDefs, this.globalConfig);
  }
  _prepareGuildConfig(guildId: string, guildConfig: Record<string, any>) {
    this.prepareConfig(`Guild ${guildId}`, this._guildConfigDefs, guildConfig, guildId);
  }

  // --- Persistence -----------------------------------------------------------

  async save(guild?: Guild) {
    await this.saveGuildConfig(guild);
    await this.savePersistentData(guild);
  }

  async saveGlobalConfig() {
    const [ok, err] = await serializeToFile(`data/module_${this.name}/global_config.json`, this.globalConfig, true);
    if (!ok) this.logWarning(null, "Failed to save global config: %s", err);
  }

  async saveGlobalPersistentData() {
    if (!this.globalPersistentData) return;
    const [ok, err] = await serializeToFile(`data/module_${this.name}/global_data.json`, this.globalPersistentData, true);
    if (!ok) this.logWarning(null, "Failed to save global data: %s", err);
  }

  async saveGuildConfig(guild?: Guild) {
    const save = async (guildId: string, config: Record<string, any>) => {
      const [ok, err] = await serializeToFile(`data/module_${this.name}/guild_${guildId}/config.json`, config, true);
      if (!ok) this.logWarning(guild ?? null, "Failed to save config: %s", err);
    };
    if (guild) {
      const config = this.getConfig(guild, true);
      if (config) await save(guild.id, config);
    } else {
      for (const [guildId, data] of this._guilds) await save(guildId, data.Config);
    }
  }

  async savePersistentData(guild?: Guild) {
    const save = async (guildId: string, data: Record<string, any>) => {
      const [ok, err] = await serializeToFile(`data/module_${this.name}/guild_${guildId}/persistentdata.json`, data);
      if (!ok) this.logWarning(guild ?? null, "Failed to save persistent data: %s", err);
    };
    if (guild) {
      const data = this.getPersistentData(guild, true);
      if (data) await save(guild.id, data);
    } else {
      await this.saveGlobalPersistentData();
      for (const [guildId, gdata] of this._guilds) await save(guildId, gdata.PersistentData);
    }
  }

  async loadGuildConfig(guild: Guild) {
    const data = this.getGuildData(guild.id)!;
    const [config, err] = await unserializeFromFile(`data/module_${this.name}/guild_${guild.id}/config.json`);
    if (config) {
      this._prepareGuildConfig(guild.id, config);
      data.Config = config as any;
      if (this.isEnabledForGuild(guild)) this.handleConfigUpdate(guild, config, null);
      return { ok: true };
    }
    this.logError(guild, "Failed to load config: %s", err);
    return { ok: false, err };
  }

  /** Load persisted config + data from disk for every guild folder present. */
  async loadModuleData() {
    const folder = `data/module_${this.name}`;
    for (const entry of await scanDir(folder)) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory) {
        const guildId = entry.name.match(/guild_(\d+)/)?.[1];
        if (!guildId) continue;
        const gdata = this.getGuildData(guildId)!;
        const [config] = await unserializeFromFile(`${path}/config.json`);
        if (config) {
          gdata.Config = config as any;
          this._prepareGuildConfig(guildId, gdata.Config);
        }
        const [persistent] = await unserializeFromFile(`${path}/persistentdata.json`);
        if (persistent) gdata.PersistentData = persistent as any;
      } else if (entry.name === "global_config.json") {
        const [config] = await unserializeFromFile(path);
        if (config) this.globalConfig = config as any;
      } else if (entry.name === "global_data.json") {
        const [d] = await unserializeFromFile(path);
        if (d) this.globalPersistentData = d as any;
      }
    }
  }
}

function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

// Ported from module_serverconfig.lua — exposes core per-guild bot settings
// (language, command prefix) through the standard config system.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";

export default class ServerConfigModule extends BotModule {
  name = "serverconfig";
  global = true;

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "Language",
        Description: "Bot language (en/fr)",
        Type: ConfigType.String,
        Default: "fr",
      },
      {
        Name: "Prefix",
        Description: "Bot command prefix",
        Type: ConfigType.String,
        Default: "!",
      },
    ];
  }
}

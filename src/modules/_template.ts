// TEMPLATE — copy this to build a new module. Files starting with "_" are NOT
// auto-loaded. See FRAMEWORK.md for the full API and the discordia->discord.js
// mapping used when porting the original module_*.lua files.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { PermissionFlagsBits } from "discord.js";

export default class TemplateModule extends BotModule {
  name = "template";
  // global = true;  // uncomment for always-on modules that can't be per-guild toggled

  // Per-guild + global configuration (optional).
  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "SomeChannel",
        Description: "A channel this module uses",
        Type: ConfigType.Channel,
        Optional: true,
      },
    ];
  }

  // Lifecycle: return true from onLoaded to accept the module.
  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "example",
      Args: [{ Name: "text", Type: ConfigType.String, Description: "Some text" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "An example command",
      Func: async (ctx, text) => {
        await ctx.reply(`You said: ${text}`);
      },
    });
    return true;
  }

  // Optional per-guild lifecycle.
  async onEnable(_guild: any): Promise<boolean> {
    return true;
  }
  async onDisable(_guild: any): Promise<void> {}
  async onUnload(): Promise<void> {}

  // Optional discord.js event hooks (only implement the ones you need):
  // async onMessageCreate(message) { ... }
  // async onGuildMemberAdd(member) { ... }
  // async onMessageReactionAdd(reaction, user) { ... }
}

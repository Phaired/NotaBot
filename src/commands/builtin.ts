// Built-in framework commands, ported from bot.lua + bot_commands.lua +
// bot_modules.lua (help, config, module management, owner commands) and extended
// with a modal-based ("form") config editor to showcase modern interactions.

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  type GuildMember,
  type Guild,
} from "discord.js";
import type { Bot } from "../core/bot";
import type { RegisteredCommand } from "../core/command";
import { ConfigType, ConfigTypeString } from "../core/configTypes";
import { unloadModule } from "../core/moduleLoader";

const MAX_FIELDS = 25;

const isAdmin = (member: GuildMember | null) =>
  !!member?.permissions.has(PermissionFlagsBits.Administrator);

export function registerBuiltinCommands(bot: Bot) {
  const isOwner = (member: GuildMember | null) => !!member && member.id === bot.config.ownerUserId;

  // --- help ------------------------------------------------------------------

  function visibleCommands(member: GuildMember | null): RegisteredCommand[] {
    const commands: RegisteredCommand[] = [];
    for (const command of bot.commands.values()) {
      // PrivilegeCheck may be async (module gating); help shows optimistically.
      commands.push(command);
    }
    return commands.sort((a, b) => a.Name.localeCompare(b.Name));
  }

  function buildUsage(command: RegisteredCommand): string {
    return command.Args.map((a) => (a.Optional ? `[${a.Name}]` : a.Name)).join(" ");
  }

  function commandFields(member: GuildMember | null) {
    return visibleCommands(member).map((command) => {
      let help = command.Help ?? "<none>";
      if (typeof help === "function") help = help(member?.guild ?? null);
      return {
        name: `**Command: ${command.Name}**`,
        value: `**Description:** ${help}\n**Usage:** ${command.Name} ${buildUsage(command)}`,
      };
    });
  }

  function helpButtons(guild: Guild | null, selectedPage: number, nbPages: number) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`help_button_previous_page_${selectedPage - 1}`)
        .setStyle(ButtonStyle.Primary)
        .setLabel("◀ Previous")
        .setDisabled(selectedPage - 1 < 1),
      new ButtonBuilder()
        .setCustomId(`help_button_next_page_${selectedPage + 1}`)
        .setStyle(ButtonStyle.Primary)
        .setLabel("Next ▶")
        .setDisabled(selectedPage + 1 > nbPages),
    );
    return [row];
  }

  bot.interactions.registerComponent("help_button", async (interaction) => {
    const fields = commandFields(interaction.member as GuildMember);
    const nbPages = Math.floor((fields.length - 1) / MAX_FIELDS) + 1;
    const selectedPage = Number(interaction.customId.match(/(\d+)$/)?.[1] ?? 1);
    if (selectedPage < 1 || selectedPage > nbPages) return;

    const page = fields.slice((selectedPage - 1) * MAX_FIELDS, selectedPage * MAX_FIELDS);
    await interaction.update({
      components: helpButtons(interaction.guild, selectedPage, nbPages),
      embeds: [new EmbedBuilder().addFields(page).setFooter({ text: `Page ${selectedPage}/${nbPages}` })],
    });
  });

  bot.registerCommand({
    Name: "help",
    Args: [{ Name: "command", Type: ConfigType.String, Optional: true, Description: "Command to detail" }],
    Help: "Lists commands or details one",
    Func: async (ctx, commandName) => {
      let fields = commandFields(ctx.member);
      if (commandName) {
        const command = bot.commands.get(String(commandName).toLowerCase());
        if (!command) return;
        let help = command.Help ?? "<none>";
        if (typeof help === "function") help = help(ctx.guild);
        fields = [
          {
            name: `**Command: ${command.Name}**`,
            value: `**Description:** ${help}\n**Usage:** ${command.Name} ${buildUsage(command)}`,
          },
        ];
      }

      let components: any[] = [];
      let footer: { text: string } | undefined;
      if (fields.length > MAX_FIELDS) {
        const nbPages = Math.floor((fields.length - 1) / MAX_FIELDS) + 1;
        fields = fields.slice(0, MAX_FIELDS);
        components = helpButtons(ctx.guild, 1, nbPages);
        footer = { text: `Page 1/${nbPages}` };
      }

      const embed = new EmbedBuilder().addFields(fields);
      if (footer) embed.setFooter(footer);
      await ctx.reply({ embeds: [embed], components });
    },
  });

  // --- modulelist ------------------------------------------------------------

  bot.registerCommand({
    Name: "modulelist",
    Args: [],
    PrivilegeCheck: isAdmin,
    Help: "Lists loaded modules",
    Func: async (ctx) => {
      const mods = [...bot.modules.values()].sort((a, b) => a.name.localeCompare(b.name));
      const lines = mods.map((mod) => {
        const emoji = mod.global ? "🌐" : mod.isEnabledForGuild(ctx.guild) ? "✅" : "❌";
        return `${emoji} **${mod.name}**`;
      });
      await ctx.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Module list")
            .addFields({ name: "Loaded modules", value: lines.join("\n") || "*none*" }),
        ],
      });
    },
  });

  // --- enable / disable / reload / unload / reloadconfig ---------------------

  bot.registerCommand({
    Name: "enable",
    Args: [{ Name: "module", Type: ConfigType.String, Description: "Module name" }],
    PrivilegeCheck: isAdmin,
    Help: "Enables a module",
    Func: async (ctx, moduleName) => {
      const { ok, err } = await bot.enableModule(String(moduleName), ctx.guild!);
      await ctx.reply(ok ? `Module **${moduleName}** enabled` : `Failed to enable **${moduleName}**: ${err}`);
    },
  });

  bot.registerCommand({
    Name: "disable",
    Args: [{ Name: "module", Type: ConfigType.String, Description: "Module name" }],
    PrivilegeCheck: isAdmin,
    Help: "Disables a module",
    Func: async (ctx, moduleName) => {
      const { ok, err } = await bot.disableModule(String(moduleName), ctx.guild!);
      await ctx.reply(ok ? `Module **${moduleName}** disabled` : `Failed to disable **${moduleName}**: ${err}`);
    },
  });

  bot.registerCommand({
    Name: "reload",
    Args: [{ Name: "module", Type: ConfigType.String, Description: "Module name" }],
    PrivilegeCheck: isAdmin,
    Help: "Reloads a module for this guild",
    Func: async (ctx, moduleName) => {
      const mod = bot.modules.get(String(moduleName));
      if (!mod) return ctx.reply(`Module **${moduleName}** doesn't exist`);
      if (!mod.isEnabledForGuild(ctx.guild)) return ctx.reply(`Module **${moduleName}** is not enabled`);
      await mod.disableForGuild(ctx.guild!, true);
      const { ok, err } = await mod.enableForGuild(ctx.guild!, false, true);
      await ctx.reply(ok ? `Module **${moduleName}** reloaded` : `Failed to re-enable: ${err}`);
    },
  });

  bot.registerCommand({
    Name: "unload",
    Args: [{ Name: "module", Type: ConfigType.String, Description: "Module name" }],
    PrivilegeCheck: isOwner,
    Help: "Unloads a module",
    Func: async (ctx, moduleName) => {
      const ok = await unloadModule(bot, String(moduleName));
      await ctx.reply(ok ? `Module **${moduleName}** unloaded.` : `Module **${moduleName}** not found.`);
    },
  });

  bot.registerCommand({
    Name: "reloadconfig",
    Args: [{ Name: "module", Type: ConfigType.String, Description: "Module name" }],
    PrivilegeCheck: isOwner,
    Help: "Reloads a module's config from disk",
    Func: async (ctx, moduleName) => {
      const mod = bot.modules.get(String(moduleName));
      if (!mod) return ctx.reply(`Module **${moduleName}** doesn't exist`);
      const { ok, err } = await mod.loadGuildConfig(ctx.guild!);
      await ctx.reply(ok ? `Module **${moduleName}** configuration reloaded` : `Failed: ${err}`);
    },
  });

  // --- config (list / show / add / remove / reset / set) ---------------------

  function fieldType(def: any) {
    let t = ConfigTypeString[def.Type];
    if (def.Array) t += " array";
    return t;
  }

  function stringifyValue(guild: Guild | null, def: any, value: any): string {
    if (value === undefined || value === null) return "<None>";
    const toString = bot.configTypes.toString[def.Type];
    if (def.Array) return value.map((v: any) => toString(v, guild ?? undefined)).join(", ");
    return toString(value, guild ?? undefined);
  }

  function generateField(guild: Guild | null, def: any, value: any, allowSensitive = false) {
    const valueStr = def.Sensitive && !allowSensitive ? "*<sensitive>*" : stringifyValue(guild, def, value);
    return {
      name: `${def.Global ? "🌐 " : ""}⚙ ${def.Name}`,
      value: `**Description:** ${def.Description}\n**Value (${fieldType(def)}):** ${valueStr}`,
    };
  }

  bot.registerCommand({
    Name: "config",
    Args: [
      { Name: "module", Type: ConfigType.String, Description: "Module name" },
      { Name: "action", Type: ConfigType.String, Optional: true, Description: "list/show/set/add/remove/reset" },
      { Name: "key", Type: ConfigType.String, Optional: true, Description: "Config key" },
      { Name: "value", Type: ConfigType.String, Optional: true, Description: "New value" },
    ],
    PrivilegeCheck: isAdmin,
    Help: "Configures a module",
    Func: async (ctx, moduleName, action, key, value) => {
      const mod = bot.modules.get(String(moduleName).toLowerCase());
      if (!mod) return ctx.reply(`Invalid module "${moduleName}"`);
      action = (action ? String(action) : "list").toLowerCase();
      const guild = ctx.guild!;
      const guildConfig = mod.getConfig(guild);
      const owner = ctx.member?.id === bot.config.ownerUserId;

      const findDef = (k: string) =>
        mod._guildConfigDefs.find((d) => d.Name === k) ??
        (owner ? mod._globalConfigDefs.find((d) => d.Name === k) : undefined);

      if (action === "list") {
        const fields = mod._guildConfigDefs.map((def) => generateField(guild, def, guildConfig?.[def.Name]));
        if (owner) for (const def of mod._globalConfigDefs) fields.push(generateField(guild, def, mod.globalConfig[def.Name]));
        const enabledText = mod.global
          ? "🌐 This module is global and cannot be toggled per-guild"
          : mod.isEnabledForGuild(guild)
            ? `✅ Module **enabled** (use \`disable ${mod.name}\` to disable it)`
            : `❌ Module **disabled** (use \`enable ${mod.name}\` to enable it)`;
        return ctx.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`Configuration for ${mod.name} module`)
              .setDescription(`${enabledText}\n\nConfiguration list:`)
              .addFields(fields.slice(0, MAX_FIELDS))
              .setFooter({ text: `Use config ${mod.name} set/add/remove/reset <key> <value>` }),
          ],
        });
      }

      if (action === "show") {
        const def = findDef(String(key));
        if (!def) return ctx.reply(`Module ${mod.name} has no config key "${key}"`);
        const config = def.Global ? mod.globalConfig : guildConfig;
        return ctx.reply({
          embeds: [new EmbedBuilder().setTitle(`Configuration of ${mod.name}`).addFields(generateField(guild, def, config?.[def.Name], true))],
        });
      }

      if (["add", "remove", "reset", "set"].includes(action)) {
        if (!key) return ctx.reply("Missing config key name");
        const def = findDef(String(key));
        if (!def) return ctx.reply(`Module ${mod.name} has no config key "${key}"`);
        if (!def.Array && (action === "add" || action === "remove"))
          return ctx.reply(`Configuration **${def.Name}** is not an array; use *set*`);

        let newValue: any;
        if (action !== "reset") {
          if (!value) return ctx.reply("Missing config value");
          const [parsed] = await bot.configTypes.parseConfig[def.Type](String(value), guild);
          if (parsed === undefined) return ctx.reply(`Failed to parse new value (type: ${ConfigTypeString[def.Type]})`);
          newValue = parsed;
        } else {
          newValue = typeof def.Default === "object" ? JSON.parse(JSON.stringify(def.Default)) : def.Default;
        }

        const config = def.Global ? mod.globalConfig : guildConfig!;
        if (action === "add") {
          const arr = (config[def.Name] ??= []);
          if (def.ArrayMaxSize && arr.length >= def.ArrayMaxSize)
            return ctx.reply(`Too many values (max ${def.ArrayMaxSize})`);
          if (!arr.includes(newValue)) arr.push(newValue);
        } else if (action === "remove") {
          const arr = config[def.Name] ?? [];
          const idx = arr.indexOf(newValue);
          if (idx !== -1) arr.splice(idx, 1);
        } else {
          config[def.Name] = def.Array && action !== "reset" ? [newValue] : newValue;
        }

        mod.handleConfigUpdate(def.Global ? null : guild, config, def.Name);
        if (def.Global) await mod.saveGlobalConfig();
        else await mod.saveGuildConfig(guild);

        return ctx.reply({
          embeds: [new EmbedBuilder().setTitle(`Configuration update for ${mod.name}`).addFields(generateField(guild, def, config[def.Name]))],
        });
      }

      return ctx.reply(`Invalid action "${action}" (valid: add, remove, reset, set, show)`);
    },
  });

  // --- configedit: modal ("form") editor -------------------------------------

  bot.registerCommand({
    Name: "configedit",
    Args: [
      { Name: "module", Type: ConfigType.String, Description: "Module name" },
      { Name: "key", Type: ConfigType.String, Description: "Config key" },
    ],
    PrivilegeCheck: isAdmin,
    Slash: true,
    Help: "Opens a form to edit a config value",
    Func: async (ctx, moduleName, key) => {
      if (!ctx.interaction) return ctx.reply("This command must be used as a slash command (`/configedit`).");
      const mod = bot.modules.get(String(moduleName).toLowerCase());
      if (!mod) return ctx.interaction.reply({ content: `Invalid module "${moduleName}"`, ephemeral: true });
      const def = mod._guildConfigDefs.find((d) => d.Name === key);
      if (!def) return ctx.interaction.reply({ content: `No config key "${key}" on ${mod.name}`, ephemeral: true });

      const current = mod.getConfig(ctx.guild!)?.[def.Name];
      const modal = new ModalBuilder()
        .setCustomId(`configedit_${mod.name}_${def.Name}`)
        .setTitle(`Edit ${def.Name}`.slice(0, 45))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("value")
              .setLabel(`New value (${ConfigTypeString[def.Type]})`.slice(0, 45))
              .setStyle(def.Array ? TextInputStyle.Paragraph : TextInputStyle.Short)
              .setValue(current !== undefined && current !== null ? String(Array.isArray(current) ? current.join(", ") : current) : "")
              .setRequired(!def.Optional),
          ),
        );
      await ctx.interaction.showModal(modal);
    },
  });

  bot.interactions.registerModal("configedit_", async (interaction) => {
    const [, moduleName, ...keyParts] = interaction.customId.split("_");
    const key = keyParts.join("_");
    const mod = bot.modules.get(moduleName);
    if (!mod || !interaction.guild) return interaction.reply({ content: "Module unavailable", ephemeral: true });
    const def = mod._guildConfigDefs.find((d) => d.Name === key);
    if (!def) return interaction.reply({ content: "Unknown config key", ephemeral: true });

    const raw = interaction.fields.getTextInputValue("value");
    const [parsed] = await bot.configTypes.parseConfig[def.Type](raw, interaction.guild);
    if (parsed === undefined) return interaction.reply({ content: `Failed to parse value (${ConfigTypeString[def.Type]})`, ephemeral: true });

    const config = mod.getConfig(interaction.guild)!;
    config[def.Name] = def.Array ? [parsed] : parsed;
    mod.handleConfigUpdate(interaction.guild, config, def.Name);
    await mod.saveGuildConfig(interaction.guild);
    await interaction.reply({ content: `✅ Updated **${def.Name}** to \`${raw}\``, ephemeral: true });
  });

  // --- owner: save / reboot --------------------------------------------------

  bot.registerCommand({
    Name: "save",
    Args: [],
    PrivilegeCheck: isOwner,
    Slash: false,
    Help: "Saves bot data",
    Func: async (ctx) => {
      await bot.save();
      await ctx.reply("Bot data saved");
    },
  });

  bot.registerCommand({
    Name: "reboot",
    Args: [],
    PrivilegeCheck: isOwner,
    Slash: false,
    Help: "Saves and restarts the bot",
    Func: async (ctx) => {
      await bot.save();
      await ctx.reply("Saving and rebooting...");
      process.exit(0);
    },
  });
}

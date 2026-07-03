// Builds Discord application (slash) commands from the registered CommandDefinitions
// and pushes them via the REST API. Called once the client is ready.

import {
  REST,
  Routes,
  ApplicationCommandOptionType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { Bot } from "./bot";
import { slashName } from "./command";
import { ConfigType } from "./configTypes";
import { logger } from "./logger";

function optionType(type: ConfigType): ApplicationCommandOptionType {
  switch (type) {
    case ConfigType.Boolean:
      return ApplicationCommandOptionType.Boolean;
    case ConfigType.Channel:
    case ConfigType.Category:
      return ApplicationCommandOptionType.Channel;
    case ConfigType.Member:
    case ConfigType.User:
      return ApplicationCommandOptionType.User;
    case ConfigType.Role:
      return ApplicationCommandOptionType.Role;
    case ConfigType.Integer:
      return ApplicationCommandOptionType.Integer;
    case ConfigType.Number:
      return ApplicationCommandOptionType.Number;
    default:
      return ApplicationCommandOptionType.String;
  }
}

export function buildSlashCommands(bot: Bot): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const payload: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];

  for (const command of bot.commands.values()) {
    if (command.Slash === false) continue;

    let description = "No description";
    if (typeof command.Help === "string") description = command.Help;
    else if (typeof command.Help === "function") {
      try {
        description = command.Help(null) || description;
      } catch {
        /* keep default */
      }
    }
    description = description.replace(/\s+/g, " ").slice(0, 100) || "No description";

    const options = command.Args.map((arg) => ({
      type: optionType(arg.Type),
      name: slashName(arg.Name),
      description: (arg.Description ?? arg.Name).slice(0, 100),
      required: !arg.Optional,
    }));

    // Discord requires required options to come before optional ones. Names (not
    // positions) drive resolution, so this reordering is safe.
    options.sort((a, b) => Number(b.required) - Number(a.required));

    payload.push({
      name: slashName(command.Name),
      description,
      options,
      dm_permission: false,
    } as RESTPostAPIChatInputApplicationCommandsJSONBody);
  }

  return payload;
}

export async function registerSlashCommands(bot: Bot) {
  const commands = buildSlashCommands(bot);
  const rest = new REST({ version: "10" }).setToken(bot.config.token);
  // The logged-in identity is authoritative: a bot's application id equals its
  // user id. Prefer it over a possibly-stale configured DISCORD_CLIENT_ID.
  const clientId = bot.client.application?.id ?? bot.client.user?.id ?? bot.config.clientId;
  if (bot.config.clientId && bot.config.clientId !== clientId) {
    logger.warning("Configured DISCORD_CLIENT_ID (%s) differs from the bot's real app id (%s); using the real one", bot.config.clientId, clientId);
  }

  try {
    if (bot.config.devGuildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, bot.config.devGuildId), { body: commands });
      logger.info("Registered %s guild slash commands (dev guild %s)", commands.length, bot.config.devGuildId);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      logger.info("Registered %s global slash commands", commands.length);
    }
  } catch (e: any) {
    logger.error("Failed to register slash commands: %s", e?.stack ?? e);
  }
}

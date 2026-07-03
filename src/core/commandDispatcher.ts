// Command dispatch for BOTH invocation paths:
//   - prefix commands  (messageCreate) — ported faithfully from bot_commands.lua
//   - slash commands   (interactionCreate / ChatInput)
//
// A single CommandDefinition drives both. Arguments are resolved to the same
// runtime types (Channel/Member/Role objects, numbers, booleans, ...) regardless
// of path, so a command's Func sees identical values either way.

import { Events, type Client, type Message, type ChatInputCommandInteraction } from "discord.js";
import type { Bot } from "./bot";
import type { RegisteredCommand, CommandArg } from "./command";
import { CommandContext, slashName } from "./command";
import { ConfigType, type ParseResult } from "./configTypes";
import { getArguments } from "../util/args";
import { logger } from "./logger";

export function installCommandDispatch(bot: Bot) {
  const client: Client = bot.client;

  client.on(Events.MessageCreate, (message) => {
    handlePrefixCommand(bot, message).catch((e) => logger.warning("Command failed: %s", e?.stack ?? e));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // Let the component/modal/autocomplete router have first refusal.
    if (!interaction.isChatInputCommand()) {
      await bot.interactions.route(interaction);
      return;
    }
    handleSlashCommand(bot, interaction).catch((e) => logger.warning("Slash command failed: %s", e?.stack ?? e));
  });
}

// --- prefix path -------------------------------------------------------------

function resolvePrefix(bot: Bot, content: string, guild: Message["guild"]): string | null {
  let prefix = bot.config.prefix;
  if (guild) {
    const serverconfig = bot.getModuleForGuild(guild, "serverconfig") as any;
    const cfg = serverconfig?.getConfig?.(guild);
    if (cfg?.Prefix) prefix = cfg.Prefix;
  }
  if (content.startsWith(prefix)) return content.slice(prefix.length);

  // Also allow @mention prefix.
  const mention = content.match(/^<@!?(\d+)>\s*(.+)/s);
  if (mention && mention[1] === bot.client.user?.id) return mention[2];

  return null;
}

async function handlePrefixCommand(bot: Bot, message: Message) {
  if (!bot.isPublicChannel(message.channel as any)) return;

  const content = resolvePrefix(bot, message.content, message.guild);
  if (!content) return;

  const m = content.match(/^(\w+)\s*([\s\S]*)/);
  if (!m) return;
  const commandName = m[1].toLowerCase();
  const rest = m[2];

  const command = bot.commands.get(commandName);
  if (!command) return;
  if (!command.BotAware && message.author.bot) return;

  if (command.PrivilegeCheck) {
    const allowed = await command.PrivilegeCheck(message.member);
    if (!allowed) {
      logger.info("%s tried to use command %s", message.author.tag, commandName);
      return;
    }
  }

  const tokens = getArguments(rest, command.Args.length);
  const [values, err] = await parseCommandArgs(bot, message.guild, command.Args, tokens);
  if (!values) {
    await message.reply(err!);
    return;
  }

  const context = CommandContext.fromMessage(message, rest);
  try {
    await command.Func(context, ...values);
  } catch (e: any) {
    logger.warning("Command %s failed: %s", commandName, e?.stack ?? e);
    await message.reply("An error occurred").catch(() => {});
  }

  if (command.Silent) await message.delete().catch(() => {});
}

/** Ported from bot_commands.lua Bot:ParseCommandArgs. */
async function parseCommandArgs(
  bot: Bot,
  guild: Message["guild"],
  expectedArgs: CommandArg[],
  tokens: string[],
): Promise<ParseResult<any[]>> {
  const parsers = bot.configTypes.parseParameter;
  const values: any[] = [];
  let argumentIndex = 0;

  for (let argIndex = 0; argIndex < expectedArgs.length; argIndex++) {
    const argData = expectedArgs[argIndex];
    if (tokens[argumentIndex] === undefined) {
      if (!argData.Optional) return [undefined, `Missing argument #${argIndex + 1} (${argData.Name})`];
      break;
    }

    // Last expected argument swallows the remaining tokens.
    let argValue: string;
    if (argIndex === expectedArgs.length - 1 && argumentIndex < tokens.length - 1) {
      argValue = tokens.slice(argumentIndex).join(" ");
    } else {
      argValue = tokens[argumentIndex];
    }

    const [value, perr] = await parsers[argData.Type](argValue, guild ?? undefined, argData.Options);
    if (value !== undefined) {
      values[argIndex] = value;
      argumentIndex++;
    } else if (argData.Optional) {
      values[argIndex] = undefined;
      // retry this token as the next parameter
    } else {
      return [undefined, `Invalid value for argument ${argIndex + 1} (${argData.Name})${perr ? ": " + perr : ""}`];
    }
  }

  return [values];
}

// --- slash path --------------------------------------------------------------

async function handleSlashCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const command = bot.commands.get(interaction.commandName.toLowerCase());
  if (!command) return;

  if (command.PrivilegeCheck) {
    const member = interaction.inCachedGuild() ? interaction.member : null;
    const allowed = await command.PrivilegeCheck(member as any);
    if (!allowed) {
      await interaction.reply({ content: "You are not allowed to use this command.", ephemeral: true });
      return;
    }
  }

  const values = await resolveSlashArgs(bot, interaction, command);
  const context = CommandContext.fromInteraction(interaction);
  try {
    await command.Func(context, ...values);
    // Guarantee the interaction is acknowledged.
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Done.", ephemeral: true }).catch(() => {});
    }
  } catch (e: any) {
    logger.warning("Slash command %s failed: %s", command.Name, e?.stack ?? e);
    const msg = { content: "An error occurred", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
}

async function resolveSlashArgs(
  bot: Bot,
  interaction: ChatInputCommandInteraction,
  command: RegisteredCommand,
): Promise<any[]> {
  const values: any[] = [];
  for (let i = 0; i < command.Args.length; i++) {
    const arg = command.Args[i];
    const name = slashName(arg.Name);
    switch (arg.Type) {
      case ConfigType.Boolean:
        values[i] = interaction.options.getBoolean(name) ?? undefined;
        break;
      case ConfigType.Channel:
      case ConfigType.Category:
        values[i] = interaction.options.getChannel(name) ?? undefined;
        break;
      case ConfigType.Member:
        values[i] = interaction.options.getMember(name) ?? undefined;
        break;
      case ConfigType.User:
        values[i] = interaction.options.getUser(name) ?? undefined;
        break;
      case ConfigType.Role:
        values[i] = interaction.options.getRole(name) ?? undefined;
        break;
      case ConfigType.Integer:
        values[i] = interaction.options.getInteger(name) ?? undefined;
        break;
      case ConfigType.Number:
        values[i] = interaction.options.getNumber(name) ?? undefined;
        break;
      default: {
        // String-backed types (String, Duration, Emoji, Message, Guild): resolve
        // via the same parser the prefix path uses.
        const raw = interaction.options.getString(name);
        if (raw === null) {
          values[i] = undefined;
        } else {
          const [value] = await bot.configTypes.parseParameter[arg.Type](raw, interaction.guild ?? undefined, arg.Options);
          values[i] = value;
        }
      }
    }
  }
  return values;
}

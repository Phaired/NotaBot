// Central registry — the TypeScript equivalent of the global `Bot` table wired up
// across bot.lua / bot_modules.lua / bot_utility.lua / bot_commands.lua.

import {
  Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
  type Message,
} from "discord.js";
import type { BotConfig } from "../config";
import type { BotModule } from "./module";
import type { CommandDefinition, RegisteredCommand } from "./command";
import {
  ConfigType,
  buildConfigTypeHandlers,
  type ConfigTypeHandlers,
  type ParseResult,
} from "./configTypes";
import { Scheduler, Timer } from "./timer";
import { EmojiRegistry, type EmojiData } from "./emoji";
import { Localization } from "./localization";
import { InteractionRouter } from "./interactions";
import { serializeToFile, unserializeFromFile } from "./storage";
import { logger } from "./logger";

const DISCORD_DOMAINS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "ptb.discordapp.com",
  "canary.discord.com",
  "canary.discordapp.com",
]);

// discord.js ChannelType numbers considered "public" (text-like) channels.
const PUBLIC_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12]); // Text, Voice, News, threads

export class Bot {
  readonly client: Client;
  readonly config: BotConfig;

  readonly commands = new Map<string, RegisteredCommand>();
  readonly modules = new Map<string, BotModule>();

  readonly scheduler = new Scheduler();
  readonly ConfigType = ConfigType;
  configTypes!: ConfigTypeHandlers;
  emoji!: EmojiRegistry;
  localization!: Localization;
  readonly interactions = new InteractionRouter();

  isReady = false;
  lastTimerExecution = -1;

  constructor(client: Client, config: BotConfig) {
    this.client = client;
    this.config = config;
  }

  /** Second-phase init once the client exists (breaks circular construction). */
  init() {
    this.configTypes = buildConfigTypeHandlers(this);
    this.emoji = new EmojiRegistry(this.client);
    this.localization = new Localization(this);
    this.scheduler.start();
  }

  // --- Commands --------------------------------------------------------------

  registerCommand(values: CommandDefinition): RegisteredCommand {
    const name = values.Name.toLowerCase();
    if (this.commands.has(name)) throw new Error(`Command "${name}" already exists`);
    const command: RegisteredCommand = { ...values, Name: name };
    this.commands.set(name, command);
    return command;
  }

  unregisterCommand(name: string) {
    this.commands.delete(name.toLowerCase());
  }

  // --- Modules ---------------------------------------------------------------

  getModuleForGuild(guild: Guild | null | undefined, moduleName: string): BotModule | null {
    const mod = this.modules.get(moduleName);
    if (!mod) return null;
    if (!guild || !mod.isEnabledForGuild(guild)) return null;
    return mod;
  }

  async enableModule(moduleName: string, guild: Guild): Promise<{ ok: boolean; err?: string }> {
    const mod = this.modules.get(moduleName);
    if (!mod) return { ok: false, err: "Module not loaded" };
    if (mod.isEnabledForGuild(guild)) return { ok: false, err: "Module is already enabled on this server" };
    return mod.enableForGuild(guild);
  }

  async disableModule(moduleName: string, guild: Guild): Promise<{ ok: boolean; err?: string }> {
    const mod = this.modules.get(moduleName);
    if (!mod) return { ok: false, err: "Module not loaded" };
    if (!mod.isEnabledForGuild(guild)) return { ok: false, err: "Module is already disabled on this server" };
    return mod.disableForGuild(guild);
  }

  // --- Timers (delegate to scheduler) ---------------------------------------

  createRepeatTimer(interval: number, repetition: number, callback: () => void | Promise<void>): Timer {
    return this.scheduler.createRepeatTimer(interval, repetition, callback);
  }
  scheduleTimer(timestamp: number, callback: () => void | Promise<void>): Timer {
    return this.scheduler.scheduleTimer(timestamp, callback);
  }
  scheduleAction(timestamp: number, callback: () => void | Promise<void>) {
    this.scheduler.scheduleAction(timestamp, callback);
  }

  // --- Localization / emoji --------------------------------------------------

  format(guild: Guild | null | undefined, key: string, ...args: any[]): string {
    return this.localization.format(guild, key, ...args);
  }
  formatDuration(guild: Guild | null | undefined, seconds: number, depth?: number): string {
    return this.localization.formatDuration(guild, seconds, depth);
  }
  getEmojiData(guild: Guild | null | undefined, idOrName: string): EmojiData | null {
    return this.emoji.getEmojiData(guild, idOrName);
  }

  // --- Persistence -----------------------------------------------------------

  serializeToFile(filepath: string, data: unknown, pretty = false) {
    return serializeToFile(filepath, data, pretty);
  }
  unserializeFromFile<T = any>(filepath: string) {
    return unserializeFromFile<T>(filepath);
  }

  async save() {
    for (const mod of this.modules.values()) {
      try {
        await mod.savePersistentData();
      } catch (e: any) {
        logger.warning("Module (%s) data save failed: %s", mod.name, e?.stack ?? e);
      }
    }
    logger.info("Modules data saved");
  }

  // --- Decode helpers (ported from bot_utility.lua) --------------------------

  async decodeChannel(guild: Guild | null | undefined, text: string): Promise<ParseResult<GuildBasedChannel>> {
    if (!guild) return [undefined, "no guild"];
    const id = text.match(/<#(\d+)>/)?.[1] ?? text.match(/^(\d+)$/)?.[1];
    if (!id) return [undefined, "Invalid channel id"];
    const channel = guild.channels.cache.get(id);
    if (!channel) return [undefined, "This channel is not part of this guild"];
    return [channel];
  }

  async decodeMember(guild: Guild | null | undefined, text: string): Promise<ParseResult<GuildMember>> {
    if (!guild) return [undefined, "no guild"];
    const id = text.match(/<@!?(\d+)>/)?.[1] ?? text.match(/^(\d+)$/)?.[1];
    if (!id) return [undefined, "Invalid user id"];
    let member = guild.members.cache.get(id);
    if (!member) member = await guild.members.fetch(id).catch(() => undefined);
    if (!member) return [undefined, "This user is not part of this guild"];
    return [member];
  }

  async decodeRole(guild: Guild | null | undefined, text: string): Promise<ParseResult<Role>> {
    if (!guild) return [undefined, "no guild"];
    const id = text.match(/<@&(\d+)>/)?.[1] ?? text.match(/^(\d+)$/)?.[1];
    if (!id) return [undefined, "Invalid role"];
    const role = guild.roles.cache.get(id);
    if (!role) return [undefined, "This role is not part of this guild"];
    return [role];
  }

  async decodeUser(text: string): Promise<ParseResult<User>> {
    const id = text.match(/<@!?(\d+)>/)?.[1] ?? text.match(/^(\d+)$/)?.[1];
    if (!id) return [undefined, "Invalid user id"];
    let user = this.client.users.cache.get(id);
    if (!user) user = await this.client.users.fetch(id).catch(() => undefined);
    if (!user) return [undefined, "Invalid user (maybe this account was deleted?)"];
    return [user];
  }

  decodeEmoji(guild: Guild | null | undefined, text: string): ParseResult<EmojiData> {
    const customId = text.match(/<a?:[\w_]+:(\d+)>/)?.[1];
    const data = this.getEmojiData(guild, customId ?? text);
    if (!data) return [undefined, customId ? "Failed to get emoji, maybe this is a global emoji?" : "Invalid emoji"];
    return [data];
  }

  async decodeMessage(
    text: string,
    ignoreEscaped = false,
    fullContent = false,
  ): Promise<ParseResult<Message>> {
    const base = "(<?)https?://([\\w.]+)/channels/(\\d+)/(\\d+)/(\\d+)(>?)";
    const re = new RegExp(fullContent ? `^${base}$` : base);
    const m = text.match(re);
    if (!m || !DISCORD_DOMAINS.has(m[2])) return [undefined, "Invalid link"];
    if (ignoreEscaped && m[1] === "<" && m[6] === ">") return [undefined, "Escaped link"];

    const guild = this.client.guilds.cache.get(m[3]);
    if (!guild) return [undefined, "Unavailable guild"];
    const channel = guild.channels.cache.get(m[4]);
    if (!channel || !channel.isTextBased()) return [undefined, "Unavailable channel"];
    const message = await channel.messages.fetch(m[5]).catch(() => undefined);
    if (!message) return [undefined, "Message not found"];
    return [message];
  }

  generateMessageLink(message: Message): string {
    const guildId = message.guild?.id ?? "@me";
    return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
  }

  isPublicChannel(channel: { type: number } | null | undefined): boolean {
    return channel ? PUBLIC_CHANNEL_TYPES.has(channel.type) : false;
  }
}

// Command definitions + a unified invocation context.
//
// A single command definition serves BOTH the legacy text-prefix path (!cmd) and
// the modern slash path (/cmd). The command's `func` receives a CommandContext
// (a thin abstraction over Message | ChatInputCommandInteraction) followed by the
// parsed/resolved arguments, exactly like the Lua `Func(message, ...args)`.

import {
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type User,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
  type InteractionReplyOptions,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";
import { ConfigType } from "./configTypes";

export interface CommandArg {
  Name: string;
  Type: ConfigType;
  Optional?: boolean;
  Description?: string; // shown in the slash-command UI
  Options?: any;
}

/** Discord requires option/command names to be lowercase and free of spaces. */
export function slashName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^-_\p{L}\p{N}]/gu, "_")
    .slice(0, 32);
}

export interface CommandDefinition {
  Name: string;
  Args: CommandArg[];
  PrivilegeCheck?: (member: GuildMember | null) => boolean | Promise<boolean>;
  Help?: string | ((guild: Guild | null) => string);
  Silent?: boolean;
  BotAware?: boolean;
  /** Set false to skip slash registration for a command (prefix-only). Default true. */
  Slash?: boolean;
  // Return value is ignored; `any` lets bodies `return ctx.reply(...)` for control flow.
  Func: (context: CommandContext, ...args: any[]) => any;
}

export interface RegisteredCommand extends CommandDefinition {
  Name: string;
}

/** Accepts either discord.js reply options or the Lua-style `{ embed, file }`. */
export type ReplyPayload =
  | string
  | (Omit<InteractionReplyOptions, "embeds" | "files"> & {
      embed?: any;
      embeds?: any[];
      file?: [string, string | Buffer] | { 0: string; 1: string | Buffer };
      files?: any[];
      content?: string;
      components?: any[];
    });

/** Convert a Lua-style reply table into discord.js message options. */
export function normalizeReply(payload: ReplyPayload): any {
  if (typeof payload === "string") return { content: payload };

  const out: any = { ...payload };

  // embed -> embeds[]
  if (out.embed) {
    out.embeds = [...(out.embeds ?? []), out.embed];
    delete out.embed;
  }
  if (out.embeds) {
    out.embeds = out.embeds.map((e: any) => (e instanceof EmbedBuilder ? e : normalizeEmbed(e)));
  }

  // file [name, data] -> files[]
  if (out.file) {
    const name = out.file[0];
    const data = out.file[1];
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    out.files = [...(out.files ?? []), new AttachmentBuilder(buf, { name })];
    delete out.file;
  }

  return out;
}

/** Convert a Lua-style embed table (snake_case fields, `image={url}`) to a plain embed object. */
export function normalizeEmbed(embed: any): any {
  if (!embed || typeof embed !== "object") return embed;
  // discord.js accepts plain APIEmbed objects; the Lua shape is already close.
  // Only need to strip Lua's `null` sentinel usages which come through as undefined.
  const clean: any = {};
  for (const [k, v] of Object.entries(embed)) {
    if (v === undefined || v === null) continue;
    clean[k] = v;
  }
  return clean;
}

/**
 * Unifies Message (prefix) and ChatInputCommandInteraction (slash). Exposes the
 * subset of the discordia Message API that ported modules actually use.
 */
export class CommandContext {
  readonly client: Client;
  readonly guild: Guild | null;
  readonly member: GuildMember | null;
  readonly author: User;
  readonly channel: TextBasedChannel | null;

  readonly message?: Message;
  readonly interaction?: ChatInputCommandInteraction;

  /** Raw text after the command (prefix path only; "" for slash). */
  readonly content: string;
  readonly attachments: any[];

  private replied = false;

  private constructor(init: Partial<CommandContext>) {
    Object.assign(this, init);
  }

  static fromMessage(message: Message, remainingContent = ""): CommandContext {
    return new CommandContext({
      client: message.client,
      guild: message.guild,
      member: message.member,
      author: message.author,
      channel: message.channel,
      message,
      content: remainingContent,
      attachments: [...message.attachments.values()],
    });
  }

  static fromInteraction(interaction: ChatInputCommandInteraction): CommandContext {
    return new CommandContext({
      client: interaction.client,
      guild: interaction.guild,
      member: (interaction.member as GuildMember) ?? null,
      author: interaction.user,
      channel: interaction.channel,
      interaction,
      content: "",
      attachments: [],
    });
  }

  /** Reply to the invoker. Works for both prefix and slash. */
  async reply(payload: ReplyPayload): Promise<Message | void> {
    const options = normalizeReply(payload);
    if (this.interaction) {
      if (this.replied || this.interaction.replied || this.interaction.deferred) {
        return (await this.interaction.followUp(options)) as unknown as Message;
      }
      this.replied = true;
      await this.interaction.reply(options);
      return;
    }
    if (this.message) {
      return await this.message.reply(options);
    }
  }

  /** Send to the channel without the reply mention. */
  async send(payload: ReplyPayload): Promise<Message | void> {
    const options = normalizeReply(payload);
    if (this.channel && "send" in this.channel) {
      return await (this.channel as any).send(options);
    }
    return this.reply(payload);
  }

  /** Delete the invoking message (prefix path); no-op for slash. */
  async delete(): Promise<void> {
    if (this.message?.deletable) await this.message.delete().catch(() => {});
  }
}

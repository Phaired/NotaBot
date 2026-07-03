// Copyright (C) 2018 Jérôme Leclercq — TypeScript rewrite
// The "ConfigType" system: a shared vocabulary of value kinds used by both the
// module configuration store and the command argument parser.
//
// For every ConfigType we provide:
//   - parseParameter : text (from a prefix command) -> resolved value (Channel, Member, ...)
//   - parseConfig    : text -> value stored in config (usually an id/string/number)
//   - toString       : stored value -> human string (for `!config` listing)
//   - validate       : is a stored value structurally valid?
//
// This mirrors bot.lua's ConfigType / ConfigTypeParameter / ConfigTypeParser /
// ConfigTypeToString tables.

import type { Guild } from "discord.js";
import type { Bot } from "./bot";

export enum ConfigType {
  Boolean = 0,
  Category = 1,
  Channel = 2,
  Custom = 3,
  Duration = 4,
  Emoji = 5,
  Guild = 6,
  Integer = 7,
  Member = 8,
  Message = 9,
  Number = 10,
  Role = 11,
  String = 12,
  User = 13,
}

export const ConfigTypeString: Record<number, string> = {};
for (const [name, value] of Object.entries(ConfigType)) {
  if (typeof value === "number") ConfigTypeString[value] = name;
}

/** A parsed result: `[value]` on success, `[undefined, error]` on failure. */
export type ParseResult<T = any> = [T] | [undefined, string];

export function ok<T>(value: T): ParseResult<T> {
  return [value];
}
export function fail(err: string): ParseResult {
  return [undefined, err];
}

import { convertToTime } from "../util/time";
import { validateSnowflake } from "../util/snowflake";

/**
 * Build the type-handler tables. They need a reference to the Bot singleton for
 * its decode helpers, so we construct them lazily once the Bot exists.
 */
export function buildConfigTypeHandlers(bot: Bot) {
  const toString: Record<number, (value: any, guild?: Guild) => string> = {
    [ConfigType.Boolean]: (v) => String(v),
    [ConfigType.Category]: (v, g) => {
      const ch = g?.channels.cache.get(v);
      return ch ? ch.toString() : "<Invalid category>";
    },
    [ConfigType.Channel]: (v, g) => {
      const ch = g?.channels.cache.get(v);
      return ch ? ch.toString() : "<Invalid channel>";
    },
    [ConfigType.Custom]: () => "<custom-type>",
    [ConfigType.Duration]: (v, g) => bot.formatDuration(g, v),
    [ConfigType.Emoji]: (v, g) => {
      const emojiData = bot.getEmojiData(g, v);
      return emojiData ? emojiData.mentionString : "<Invalid emoji>";
    },
    [ConfigType.Integer]: (v) => String(v),
    [ConfigType.Guild]: (v) => {
      const g = bot.client.guilds.cache.get(v);
      return g ? g.name : "<Unknown guild>";
    },
    [ConfigType.Member]: (v, g) => {
      const m = g?.members.cache.get(v);
      return m ? m.toString() : "<Invalid member>";
    },
    [ConfigType.Message]: (v) => String(v),
    [ConfigType.Number]: (v) => String(v),
    [ConfigType.Role]: (v, g) => {
      const r = g?.roles.cache.get(v);
      return r ? r.toString() : "<Invalid role>";
    },
    [ConfigType.String]: (v) => String(v),
    [ConfigType.User]: (v) => {
      const u = bot.client.users.cache.get(v);
      return u ? u.toString() : "<Invalid user>";
    },
  };

  // Resolve raw text into a runtime value (used by prefix commands).
  const parseParameter: Record<
    number,
    (value: string, guild?: Guild, options?: any) => Promise<ParseResult> | ParseResult
  > = {
    [ConfigType.Boolean]: (v) => {
      if (v === "yes" || v === "1" || v === "true") return ok(true);
      if (v === "no" || v === "0" || v === "false") return ok(false);
      return fail("expected a boolean (yes/no)");
    },
    [ConfigType.Category]: async (v, g) => {
      const [ch, err] = await bot.decodeChannel(g, v);
      if (!ch) return fail(err!);
      if (ch.type !== 4 /* GuildCategory */) return fail("expected category");
      return ok(ch);
    },
    [ConfigType.Channel]: (v, g) => bot.decodeChannel(g, v),
    [ConfigType.Custom]: () => fail("custom type cannot be parsed from text"),
    [ConfigType.Duration]: (v) => {
      const s = convertToTime(v);
      return s === undefined ? fail("invalid duration") : ok(s);
    },
    [ConfigType.Emoji]: (v, g) => bot.decodeEmoji(g, v),
    [ConfigType.Integer]: (v) => {
      const m = v.match(/^(\d+)$/);
      return m ? ok(parseInt(m[1], 10)) : fail("expected an integer");
    },
    [ConfigType.Guild]: (v) => {
      const [okv, err] = validateSnowflake(v);
      if (!okv) return fail(err!);
      const g = bot.client.guilds.cache.get(v);
      if (!g) return fail(`${v} is not a guild I know`);
      return ok(g);
    },
    [ConfigType.Member]: (v, g) => bot.decodeMember(g, v),
    [ConfigType.Message]: (v) => bot.decodeMessage(v, false, true),
    [ConfigType.Number]: (v) => {
      const n = Number(v);
      return Number.isNaN(n) ? fail("expected a number") : ok(n);
    },
    [ConfigType.Role]: (v, g) => bot.decodeRole(g, v),
    [ConfigType.String]: (v) => ok(v),
    [ConfigType.User]: (v) => bot.decodeUser(v),
  };

  // Resolve raw text into the value we persist in config (usually an id).
  const parseConfig: Record<
    number,
    (value: string, guild?: Guild) => Promise<ParseResult> | ParseResult
  > = {
    [ConfigType.Boolean]: parseParameter[ConfigType.Boolean],
    [ConfigType.Category]: async (v, g) => {
      const [ch, err] = (await parseParameter[ConfigType.Category](v, g)) as ParseResult;
      return ch ? ok((ch as any).id) : fail(err!);
    },
    [ConfigType.Channel]: async (v, g) => {
      const [ch] = await bot.decodeChannel(g, v);
      return ch ? ok(ch.id) : fail("invalid channel");
    },
    [ConfigType.Custom]: () => fail("custom type cannot be parsed from text"),
    [ConfigType.Duration]: parseParameter[ConfigType.Duration],
    [ConfigType.Emoji]: async (v, g) => {
      const [emojiData] = await bot.decodeEmoji(g, v);
      return emojiData ? ok((emojiData as any).name) : fail("invalid emoji");
    },
    [ConfigType.Integer]: parseParameter[ConfigType.Integer],
    [ConfigType.Guild]: async (v) => {
      const [okv, err] = validateSnowflake(v);
      if (!okv) return fail(err!);
      const g = bot.client.guilds.cache.get(v);
      return g ? ok(g.id) : fail(`${v} is not a guild I know`);
    },
    [ConfigType.Member]: async (v, g) => {
      const [m] = await bot.decodeMember(g, v);
      return m ? ok((m as any).id) : fail("invalid member");
    },
    [ConfigType.Message]: async (v) => {
      const [msg] = await bot.decodeMessage(v, false, true);
      return msg ? ok(bot.generateMessageLink(msg as any)) : fail("invalid message");
    },
    [ConfigType.Number]: parseParameter[ConfigType.Number],
    [ConfigType.Role]: async (v, g) => {
      const [r] = await bot.decodeRole(g, v);
      return r ? ok((r as any).id) : fail("invalid role");
    },
    [ConfigType.String]: (v) => ok(v),
    [ConfigType.User]: async (v) => {
      const [u] = await bot.decodeUser(v);
      return u ? ok((u as any).id) : fail("invalid user");
    },
  };

  const validate: Record<number, (value: any) => ParseResult<boolean>> = {
    [ConfigType.Boolean]: (v) => (typeof v === "boolean" ? ok(true) : fail("boolean expected")),
    [ConfigType.Category]: (v) => validateSnowflake(v),
    [ConfigType.Channel]: (v) => validateSnowflake(v),
    [ConfigType.Custom]: () => ok(true),
    [ConfigType.Duration]: (v) => (typeof v === "number" ? ok(true) : fail("number expected")),
    [ConfigType.Emoji]: (v) => (typeof v === "string" ? ok(true) : fail("string expected")),
    [ConfigType.Integer]: (v) =>
      typeof v === "number" && Number.isInteger(v) ? ok(true) : fail("integer expected"),
    [ConfigType.Guild]: (v) => validateSnowflake(v),
    [ConfigType.Number]: (v) => (typeof v === "number" ? ok(true) : fail("number expected")),
    [ConfigType.Role]: (v) => validateSnowflake(v),
    [ConfigType.String]: (v) => (typeof v === "string" ? ok(true) : fail("string expected")),
    [ConfigType.User]: (v) => validateSnowflake(v),
  };

  return { toString, parseParameter, parseConfig, validate };
}

export type ConfigTypeHandlers = ReturnType<typeof buildConfigTypeHandlers>;

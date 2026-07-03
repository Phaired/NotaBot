// Ported from utils.lua `util.ValidateSnowflake`.
import type { ParseResult } from "../core/configTypes";

export function validateSnowflake(snowflake: unknown): ParseResult<boolean> {
  if (typeof snowflake !== "string") return [undefined, "not a string"];
  if (!/\d+/.test(snowflake)) return [undefined, "must contain only numbers"];
  return [true];
}

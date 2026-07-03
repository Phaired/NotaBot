// Runtime configuration, loaded from environment variables (.env). Replaces
// config.lua. Module autoloading is discovery-based (every file in src/modules).

import * as dotenv from "dotenv";
dotenv.config();

export interface BotConfig {
  token: string;
  clientId: string;
  ownerUserId: string;
  prefix: string;
  devGuildId?: string;
}

export function loadConfig(): BotConfig {
  const token = process.env.DISCORD_TOKEN ?? "";
  if (!token) throw new Error("DISCORD_TOKEN is not set (copy .env.example to .env)");

  return {
    token,
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
    ownerUserId: process.env.OWNER_USER_ID ?? "",
    prefix: process.env.PREFIX ?? "!",
    devGuildId: process.env.DEV_GUILD_ID || undefined,
  };
}

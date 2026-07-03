// Routes discord.js client events to module event hooks, gated by whether the
// module is enabled for the event's guild. This replaces bot_modules.lua's
// discordiaEvents table + MakeModuleReady event binding.
//
// Modules implement handlers named after these keys (e.g. onMessageCreate,
// onGuildMemberAdd). See FRAMEWORK.md for the discordia -> discord.js mapping.

import { Events, type Client, type Guild } from "discord.js";
import type { Bot } from "./bot";
import { logger } from "./logger";

interface EventBinding {
  event: string;
  guildFrom: (...args: any[]) => Guild | null | undefined;
}

// handler method name on the module -> discord.js event + guild extractor
export const MODULE_EVENTS: Record<string, EventBinding> = {
  onChannelCreate: { event: Events.ChannelCreate, guildFrom: (c) => c?.guild },
  onChannelDelete: { event: Events.ChannelDelete, guildFrom: (c) => c?.guild },
  onChannelUpdate: { event: Events.ChannelUpdate, guildFrom: (_o, n) => n?.guild },
  onChannelPinsUpdate: { event: Events.ChannelPinsUpdate, guildFrom: (c) => c?.guild },
  onGuildAvailable: { event: Events.GuildAvailable, guildFrom: (g) => g },
  onGuildCreate: { event: Events.GuildCreate, guildFrom: (g) => g },
  onGuildDelete: { event: Events.GuildDelete, guildFrom: (g) => g },
  onGuildUpdate: { event: Events.GuildUpdate, guildFrom: (_o, n) => n },
  onGuildMemberAdd: { event: Events.GuildMemberAdd, guildFrom: (m) => m?.guild },
  onGuildMemberRemove: { event: Events.GuildMemberRemove, guildFrom: (m) => m?.guild },
  onGuildMemberUpdate: { event: Events.GuildMemberUpdate, guildFrom: (_o, n) => n?.guild },
  onMessageCreate: { event: Events.MessageCreate, guildFrom: (m) => m?.guild },
  onMessageUpdate: { event: Events.MessageUpdate, guildFrom: (_o, n) => n?.guild },
  onMessageDelete: { event: Events.MessageDelete, guildFrom: (m) => m?.guild },
  onMessageDeleteBulk: { event: Events.MessageBulkDelete, guildFrom: (msgs) => msgs?.first?.()?.guild },
  onMessageReactionAdd: { event: Events.MessageReactionAdd, guildFrom: (r) => r?.message?.guild },
  onMessageReactionRemove: { event: Events.MessageReactionRemove, guildFrom: (r) => r?.message?.guild },
  onMessageReactionRemoveAll: { event: Events.MessageReactionRemoveAll, guildFrom: (m) => m?.guild },
  onGuildBanAdd: { event: Events.GuildBanAdd, guildFrom: (ban) => ban?.guild },
  onGuildBanRemove: { event: Events.GuildBanRemove, guildFrom: (ban) => ban?.guild },
  onRoleCreate: { event: Events.GuildRoleCreate, guildFrom: (r) => r?.guild },
  onRoleDelete: { event: Events.GuildRoleDelete, guildFrom: (r) => r?.guild },
  onRoleUpdate: { event: Events.GuildRoleUpdate, guildFrom: (_o, n) => n?.guild },
  onVoiceStateUpdate: { event: Events.VoiceStateUpdate, guildFrom: (_o, n) => n?.guild },
  onPresenceUpdate: { event: Events.PresenceUpdate, guildFrom: (_o, n) => n?.guild },
  onTypingStart: { event: Events.TypingStart, guildFrom: (t) => t?.guild },
  onWebhooksUpdate: { event: Events.WebhooksUpdate, guildFrom: (c) => c?.guild },
  onInteractionCreate: { event: Events.InteractionCreate, guildFrom: (i) => i?.guild },
};

/** Bind every supported event once; each fan-outs to enabled modules. */
export function installModuleEventDispatch(bot: Bot) {
  const client: Client = bot.client;
  const boundEvents = new Set<string>();

  for (const [handlerName, binding] of Object.entries(MODULE_EVENTS)) {
    if (boundEvents.has(binding.event)) continue;
    boundEvents.add(binding.event);

    // Collect all handler names that share this discord.js event.
    const handlersForEvent = Object.entries(MODULE_EVENTS).filter(([, b]) => b.event === binding.event);

    client.on(binding.event, (...args: any[]) => {
      for (const [name, b] of handlersForEvent) {
        const guild = b.guildFrom(...args);
        for (const mod of bot.modules.values()) {
          const handler = (mod as any)[name];
          if (typeof handler !== "function") continue;
          if (guild && !mod.isEnabledForGuild(guild)) continue;
          Promise.resolve(handler.apply(mod, args)).catch((e) =>
            logger.warning("Module (%s) %s failed: %s", mod.name, name, e?.stack ?? e),
          );
        }
      }
    });
  }
}

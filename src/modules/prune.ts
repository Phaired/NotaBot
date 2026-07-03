// Ported from module_prune.lua — bulk-deletes messages via !prune / !prunefrom.
//
// API limitations on bulk deletion (kept from the Lua source):
//  - It is not possible to bulk-delete less than 2 or more than 100 messages at a time.
//  - It is not possible to delete messages older than 14 days.
//  - Fetching messages before/after a given id is also limited to 100 at a time.
//
// Note on error handling: the Lua version never checked the return value of
// `channel:bulkDelete(...)` / `message:delete()` (discordia returns `nil, err`
// on failure rather than throwing, and both call sites ignored it, blindly
// counting the chunk as deleted regardless). That's reproduced below with
// `.catch(() => {})` around those two calls. Message *fetching*
// (`getMessagesBefore`/`getMessagesAfter`) was NOT protected in the Lua code
// (calling `:toArray()` on a failed `nil` result would itself error out), so
// those calls are left unguarded here too and simply propagate/abort the
// command the same way the original did (the command dispatcher already
// replies "An error occurred" on an uncaught Func exception).

import { BotModule } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { PermissionFlagsBits, type Collection, type Message, type GuildMember } from "discord.js";
import { osTime } from "../util/time";

const MSG_TIME_LIMIT = 1209600; // seconds (14 days)
const NB_MSG_MAX_LIMIT = 100;

function hasValidDate(message: Message): boolean {
  const messageTimestamp = Math.floor(message.createdTimestamp / 1000);
  return osTime() - messageTimestamp < MSG_TIME_LIMIT;
}

function hasManagePermission(member: GuildMember | null): boolean {
  return !!member?.permissions.has(PermissionFlagsBits.ManageMessages);
}

/**
 * Sorts a fetched page of messages ascending by id (oldest first) and keeps only
 * those still eligible for bulk deletion. Mirrors the Lua
 * `Iterable:toArray("id", hasValidDate)` call.
 */
function sortAndFilter(collection: Collection<string, Message> | null | undefined): Message[] {
  if (!collection) return [];
  return [...collection.values()].filter(hasValidDate).sort((a, b) => {
    const ai = BigInt(a.id);
    const bi = BigInt(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

export default class PruneModule extends BotModule {
  name = "prune";

  /**
   * Deletes each chunk: >1 message goes through bulkDelete, exactly 1 message
   * is deleted individually (matches the Lua `bulkDeleteChunks`). Empty chunks
   * are skipped defensively — the Lua original would crash on `chunk[1]:delete()`
   * with a nil chunk (an edge case reachable when a trailing fetch/removal ends
   * up empty); skipping it just means those 0 messages aren't counted, which is
   * the same observable outcome minus the crash.
   */
  private async bulkDeleteChunks(channel: any, messagesChunks: Message[][]): Promise<number> {
    let nbDeletedMessages = 0;

    for (const chunk of messagesChunks) {
      if (chunk.length === 0) continue;
      if (chunk.length > 1) {
        await channel.bulkDelete(chunk).catch(() => {});
        nbDeletedMessages += chunk.length;
      } else {
        await chunk[0].delete().catch(() => {});
        nbDeletedMessages += 1;
      }
    }

    return nbDeletedMessages;
  }

  private async bulkDeleteByNumber(channel: any, anchorMessageId: string, nbMessages: number): Promise<number> {
    let currentMessageId = anchorMessageId;
    const messagesToDelete: Message[][] = [];

    const quotient = Math.floor(nbMessages / NB_MSG_MAX_LIMIT);
    const remainder = nbMessages - quotient * NB_MSG_MAX_LIMIT;

    for (let i = 0; i < quotient; i++) {
      const fetched = await channel.messages.fetch({ before: currentMessageId, limit: NB_MSG_MAX_LIMIT });
      const messages = sortAndFilter(fetched);

      if (messages.length > 0) {
        messagesToDelete.push(messages);
        currentMessageId = messages[0].id;
      }
    }

    if (remainder > 0) {
      const fetched = await channel.messages.fetch({ before: currentMessageId, limit: remainder });
      messagesToDelete.push(sortAndFilter(fetched));
    }

    return this.bulkDeleteChunks(channel, messagesToDelete);
  }

  private async bulkDeleteById(channel: any, targetMessage: Message, stripInvokingMessage: boolean): Promise<number> {
    let currentMessageId = targetMessage.id;
    const messagesToDelete: Message[][] = [];

    let messages: Message[];
    do {
      const fetched = await channel.messages.fetch({ after: currentMessageId, limit: NB_MSG_MAX_LIMIT });
      messages = sortAndFilter(fetched);

      if (messages.length > 0) {
        messagesToDelete.push(messages);
        currentMessageId = messages[messages.length - 1].id;
      }
    } while (messages.length > 0);

    // This command is silent, so the invoking message will be deleted by the
    // command framework itself afterwards; strip it here so we don't try to
    // delete it twice. (Only applies to the prefix path — a slash-command
    // invocation never posts a message in the channel to begin with.)
    if (stripInvokingMessage) {
      messagesToDelete[messagesToDelete.length - 1]?.pop();
    }

    // Delete also the selected (target) message.
    if (hasValidDate(targetMessage)) {
      const lastChunk = messagesToDelete[messagesToDelete.length - 1];
      if (lastChunk) lastChunk.push(targetMessage);
      else messagesToDelete.push([targetMessage]);
    }

    return this.bulkDeleteChunks(channel, messagesToDelete);
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "prune",
      Args: [{ Name: "nbMessages", Type: ConfigType.Integer, Description: "Number of messages to delete" }],
      PrivilegeCheck: hasManagePermission,
      Help: (guild) => this.bot.format(guild, "PRUNE_HELP"),
      Silent: true,
      Func: async (ctx, nbMessages: number) => {
        const guild = ctx.guild;
        const channel = ctx.channel as any;
        if (!channel?.messages) return;

        // Mirrors the Lua `commandMessage.id`: the point in time to fetch
        // messages before. A slash-command invocation never posts a message of
        // its own, so fall back to the interaction's id — Discord snowflakes are
        // comparable across object types (they just encode a timestamp), so it
        // works as a "before now" cursor just as well.
        const anchorMessageId = ctx.message?.id ?? ctx.interaction?.id;
        if (!anchorMessageId) return;

        const nbDeletedMessages = await this.bulkDeleteByNumber(channel, anchorMessageId, nbMessages);

        let response = "";
        if (nbDeletedMessages !== nbMessages) {
          response = `${this.bot.format(guild, "PRUNE_CANNOT_DELETE")}\n`;
        }
        response += this.bot.format(guild, "PRUNE_RESULT", nbDeletedMessages);

        await ctx.reply(response);
      },
    });

    this.registerCommand({
      Name: "prunefrom",
      Args: [{ Name: "messageId", Type: ConfigType.Message, Description: "The link of the message to prune from" }],
      PrivilegeCheck: hasManagePermission,
      Help: (guild) => this.bot.format(guild, "PRUNEFROM_HELP"),
      Silent: true,
      Func: async (ctx, targetMessage: Message) => {
        const guild = ctx.guild;
        const channel = ctx.channel as any;
        if (!channel?.messages) return;

        const nbDeletedMessages = await this.bulkDeleteById(channel, targetMessage, !!ctx.message);

        let response = "";
        if (!hasValidDate(targetMessage)) {
          response = `${this.bot.format(guild, "PRUNE_CANNOT_DELETE")}\n`;
        }
        response += this.bot.format(guild, "PRUNE_RESULT", nbDeletedMessages);

        await ctx.reply(response);
      },
    });

    return true;
  }
}

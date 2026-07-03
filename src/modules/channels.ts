// Ported from module_channels.lua — lets admins bind roles (add/remove/toggle)
// and/or a DM message to a reaction on a given message ("reaction roles"), and
// keeps those messages' reactions in sync with the configuration.
//
// Note on porting OnReactionAdd / OnReactionAddUncached: the Lua bot needed two
// separate hooks because discordia only delivered a full Reaction object when the
// message was already cached (OnReactionAdd), falling back to raw ids otherwise
// (OnReactionAddUncached, which had to re-fetch the message/reaction by hand).
// discord.js unifies both cases behind a single `MessageReactionAdd` event plus
// its `partial` flag/`.fetch()` mechanism, so both Lua hooks are merged into the
// single `onMessageReactionAdd` below (same approach as src/modules/pin.ts).

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType, type ParseResult } from "../core/configTypes";
import type { EmojiData } from "../core/emoji";
import { validateSnowflake } from "../util/snowflake";
import {
  PermissionFlagsBits,
  type Guild,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from "discord.js";

// Word -> digit ordering used to sort single-digit-emoji reactions in a sane
// order (0..9) instead of alphabetically ("eight" < "five" < ... < "zero").
const emojiOrder: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RoleActionData {
  Add: string[];
  Remove: string[];
  Toggle: string[];
  Message?: string;
}

export default class ChannelsModule extends BotModule {
  name = "channels";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "ReactionActions",
        Description:
          "Map explaining which role to add/remove from which reaction on which message, use the !channelconfig command to setup this",
        Type: ConfigType.Custom,
        Default: {},
        ValidateConfig: (value: any): ParseResult<boolean> => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return [undefined, "ReactionActions must be an array"];
          }

          for (const [channelId, messageTable] of Object.entries(value)) {
            const [okChannel] = validateSnowflake(channelId);
            if (!okChannel) return [undefined, "ReactionActions keys must be channel snowflakes"];

            if (typeof messageTable !== "object" || messageTable === null || Array.isArray(messageTable)) {
              return [undefined, `ReactionActions[${channelId}] must be an object`];
            }

            for (const [messageId, reactionTable] of Object.entries(messageTable as Record<string, any>)) {
              const [okMessage] = validateSnowflake(messageId);
              if (!okMessage) {
                return [undefined, `ReactionActions[${channelId}] keys must be message snowflakes (${messageId})`];
              }

              if (typeof reactionTable !== "object" || reactionTable === null || Array.isArray(reactionTable)) {
                return [undefined, `ReactionActions[${channelId}][${messageId}] must be an object`];
              }

              for (const [emoji, actions] of Object.entries(reactionTable as Record<string, any>)) {
                if (typeof emoji !== "string") {
                  return [undefined, `ReactionActions[${channelId}][${messageId}] keys must be strings (${emoji})`];
                }

                if (typeof actions !== "object" || actions === null || Array.isArray(actions)) {
                  return [undefined, `ReactionActions[${channelId}][${messageId}][${emoji}] must be an object`];
                }

                for (const [actionType, values] of Object.entries(actions as Record<string, any>)) {
                  if (actionType === "AddRoles" || actionType === "RemoveRoles" || actionType === "ToggleRoles") {
                    if (!Array.isArray(values)) {
                      return [
                        undefined,
                        `ReactionActions[${channelId}][${messageId}][${emoji}].${actionType} must be an array`,
                      ];
                    }
                    for (let i = 0; i < values.length; i++) {
                      const [okRole] = validateSnowflake(values[i]);
                      if (!okRole) {
                        return [
                          undefined,
                          `ReactionActions[${channelId}][${messageId}][${emoji}].${actionType}[${i}] isn't a snowflake`,
                        ];
                      }
                    }
                  } else if (actionType === "SendMessage") {
                    if (typeof values !== "string") {
                      return [
                        undefined,
                        `ReactionActions[${channelId}][${messageId}][${emoji}].${actionType} value must be a string`,
                      ];
                    }
                  } else {
                    return [
                      undefined,
                      `ReactionActions[${channelId}][${messageId}][${emoji}].${actionType} is not a valid action type`,
                    ];
                  }
                }
              }
            }
          }

          return [true];
        },
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "channelconfig",
      Args: [
        {
          Name: "configMessage",
          Type: ConfigType.Message,
          Optional: true,
          Description: "Only list reactions for this message (link)",
        },
      ],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Lists the channel module messages and reactions",
      Func: async (ctx, configMessage?: Message) => {
        const guild = ctx.guild;
        if (!guild) return;
        const config = this.getConfig(guild);
        if (!config) return;

        const channelConfig: Record<string, Record<string, Record<string, any>>> = config.ReactionActions ?? {};
        for (const [channelId, messageTable] of Object.entries(channelConfig)) {
          const channel = guild.channels.cache.get(channelId);
          if (!channel || !channel.isTextBased()) continue;

          for (const [messageId, reactionTable] of Object.entries(messageTable)) {
            const message = await this.fetchMessage(channel as any, messageId);
            if (message && (!configMessage || configMessage.id === message.id)) {
              const fields: { name: string; value: string }[] = [];

              for (const [emojiKey, actions] of Object.entries(reactionTable)) {
                const actionStr: string[] = [];

                if (actions.AddRoles) {
                  const addedRoles = (actions.AddRoles as string[]).map((roleId) => {
                    const role = guild.roles.cache.get(roleId);
                    return role ? role.toString() : `<invalid role ${roleId}>`;
                  });
                  if (addedRoles.length > 0) {
                    actionStr.push(`**Adds role${addedRoles.length > 1 ? "s" : ""}** ${addedRoles.join(", ")}\n`);
                  }
                }

                if (actions.RemoveRoles) {
                  const removedRoles = (actions.RemoveRoles as string[]).map((roleId) => {
                    const role = guild.roles.cache.get(roleId);
                    return role ? role.toString() : `<invalid role ${roleId}>`;
                  });
                  if (removedRoles.length > 0) {
                    actionStr.push(
                      `**Removes role${removedRoles.length > 1 ? "s" : ""}** ${removedRoles.join(", ")}\n`,
                    );
                  }
                }

                if (actions.SendMessage) {
                  actionStr.push(`**Sends private message:**\n"${actions.SendMessage}"\n`);
                }

                if (actions.ToggleRoles) {
                  const toggleRoles = (actions.ToggleRoles as string[]).map((roleId) => {
                    const role = guild.roles.cache.get(roleId);
                    return role ? role.toString() : `<invalid role ${roleId}>`;
                  });
                  if (toggleRoles.length > 0) {
                    actionStr.push(`**Toggles role${toggleRoles.length > 1 ? "s" : ""}** ${toggleRoles.join(", ")}`);
                  }
                }

                const emoji = this.bot.getEmojiData(guild, emojiKey);

                fields.push({
                  name: `- ${emoji ? emoji.mentionString : "<invalid emoji>"}:`,
                  value: actionStr.join("\n"),
                });
              }

              await ctx.reply({
                embed: {
                  description: `Message in ${channel.toString()}:\n${this.bot.generateMessageLink(message)}`,
                  fields,
                  footer: {
                    text: "Use `!updatechannelconfig <message link> <emoji> <action> <data>` to update channels reactions settings.",
                  },
                },
              });
            }
          }
        }
      },
    });

    this.registerCommand({
      Name: "updatechannelconfig",
      Args: [
        { Name: "message", Type: ConfigType.Message, Description: "Message link" },
        { Name: "emoji", Type: ConfigType.Emoji, Description: "Reaction emoji" },
        {
          Name: "action",
          Type: ConfigType.String,
          Description: "addrole/removerole/togglerole/send/clear",
        },
        { Name: "value", Type: ConfigType.String, Optional: true, Description: "Role or message content" },
      ],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Configures the channel module messages and reactions",
      Func: async (ctx, message: Message, emoji: EmojiData, action: string, value?: string) => {
        const guild = ctx.guild;
        const member = ctx.member;
        if (!guild || !member) return;
        const config = this.getConfig(guild);
        if (!config) return;
        if (!config.ReactionActions) config.ReactionActions = {};

        const getReactionActionsConfig = (
          channelId: string,
          messageId: string,
          reaction: string,
          noCreate = false,
        ): Record<string, any> | undefined => {
          const guildConfig = config.ReactionActions;

          let channelTable = guildConfig[channelId];
          if (!channelTable) {
            if (noCreate) return undefined;
            channelTable = {};
            guildConfig[channelId] = channelTable;
          }

          let messageTable = channelTable[messageId];
          if (!messageTable) {
            if (noCreate) return undefined;
            messageTable = {};
            channelTable[messageId] = messageTable;
          }

          let reactionActions = messageTable[reaction];
          if (!reactionActions) {
            if (noCreate) return undefined;
            reactionActions = {};
            messageTable[reaction] = reactionActions;
          }

          return reactionActions;
        };

        let success = false;

        if (action === "addrole" || action === "removerole" || action === "togglerole") {
          const [role, err] = await this.bot.decodeRole(guild, value ?? "");
          if (!role) {
            await ctx.reply(`Invalid role: ${err}`);
            return;
          }

          if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            await ctx.reply("you need to have the manage roles permission to toggle a role");
            return;
          }

          if (role.position > member.roles.highest.position) {
            await ctx.reply("you cannot add or remove a role higher than your own");
            return;
          }

          const roleValue = role.id;
          const reactionActions = getReactionActionsConfig(message.channel.id, message.id, emoji.name)!;

          if (action === "addrole") {
            if (reactionActions.AddRoles) {
              if (!reactionActions.AddRoles.includes(roleValue)) reactionActions.AddRoles.push(roleValue);
            } else {
              reactionActions.AddRoles = [roleValue];
            }
            if (reactionActions.RemoveRoles) {
              reactionActions.RemoveRoles = reactionActions.RemoveRoles.filter((v: string) => v !== roleValue);
            }
            if (reactionActions.ToggleRoles) {
              reactionActions.ToggleRoles = reactionActions.ToggleRoles.filter((v: string) => v !== roleValue);
            }

            success = true;
            await ctx.reply(
              `Reactions on ${this.bot.generateMessageLink(message)} for ${emoji.mentionString} will now adds role ${role.name} (${role.id})`,
            );
          } else if (action === "removerole") {
            if (reactionActions.RemoveRoles) {
              if (!reactionActions.RemoveRoles.includes(roleValue)) reactionActions.RemoveRoles.push(roleValue);
            } else {
              reactionActions.RemoveRoles = [roleValue];
            }
            if (reactionActions.AddRoles) {
              reactionActions.AddRoles = reactionActions.AddRoles.filter((v: string) => v !== roleValue);
            }
            if (reactionActions.ToggleRoles) {
              reactionActions.ToggleRoles = reactionActions.ToggleRoles.filter((v: string) => v !== roleValue);
            }

            success = true;
            await ctx.reply(
              `Reactions on ${this.bot.generateMessageLink(message)} for ${emoji.mentionString} will now remove role ${role.name} (${role.id})`,
            );
          } else {
            // togglerole
            if (reactionActions.ToggleRoles) {
              if (!reactionActions.ToggleRoles.includes(roleValue)) reactionActions.ToggleRoles.push(roleValue);
            } else {
              reactionActions.ToggleRoles = [roleValue];
            }
            if (reactionActions.AddRoles) {
              reactionActions.AddRoles = reactionActions.AddRoles.filter((v: string) => v !== roleValue);
            }
            if (reactionActions.RemoveRoles) {
              reactionActions.RemoveRoles = reactionActions.RemoveRoles.filter((v: string) => v !== roleValue);
            }

            success = true;
            await ctx.reply(
              `Reactions on ${this.bot.generateMessageLink(message)} for ${emoji.mentionString} will now toggle role ${role.name} (${role.id})`,
            );
          }
        } else if (action === "send") {
          if (!value) {
            await ctx.reply("Empty message");
            return;
          }

          const reactionActions = getReactionActionsConfig(message.channel.id, message.id, emoji.name)!;
          reactionActions.SendMessage = value;

          success = true;
          await ctx.reply(
            `Reactions on ${this.bot.generateMessageLink(message)} for ${emoji.mentionString} will now send private message: ${value}`,
          );
        } else if (action === "clear") {
          const reactionActions = getReactionActionsConfig(message.channel.id, message.id, emoji.name, true);
          if (reactionActions) {
            delete reactionActions.AddRoles;
            delete reactionActions.RemoveRoles;
            delete reactionActions.ToggleRoles;
            delete reactionActions.SendMessage;
          }

          success = true;
          await ctx.reply(
            `Reactions actions on ${this.bot.generateMessageLink(message)} for ${emoji.mentionString} have been cleared`,
          );
        } else {
          await ctx.reply("Invalid action (must be addrole/clear/removerole/send/togglerole)");
        }

        if (success) {
          await this.saveGuildConfig(guild);
          await ctx.reply(
            `Configuration of module ${this.name} has been saved, use the \`!reload ${this.name}\` command to activate it`,
          );
        }
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;

    const data = this.getData(guild)!;
    data.ReactionActions = {};

    await this.handleConfig(guild, config);

    return true;
  }

  /** Reacts to config changes made through `!config` (outside of `!updatechannelconfig`). */
  handleConfigUpdate(guild: Guild | null, config: Record<string, any>, configName: string | null): void {
    if ((!configName || configName === "ReactionActions") && guild) {
      this.handleConfig(guild, config).catch((err: any) => {
        this.logError(guild, "HandleConfig failed: %s", err?.stack ?? err);
      });
    }
  }

  async onMessageReactionAdd(
    reactionIn: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    let reaction = reactionIn;

    const channel = reaction.message.channel;
    if (!this.bot.isPublicChannel(channel as any)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    const idOrName = reaction.emoji.id ?? reaction.emoji.name;
    if (!idOrName) return;

    const emoji = this.bot.getEmojiData(guild, idOrName);
    if (!emoji) return;

    // Resolve partial reaction/message (equivalent of the Lua "uncached" path).
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return; // Maybe the reaction has been removed
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        return; // Maybe the message has been deleted
      }
    }

    const message = reaction.message as Message;

    if (await this.handleReactionAdd(guild, user.id, message.channel.id, message.id, emoji.name)) {
      await sleep(1000); // Wait a bit before removing reaction (so user won't think it failed)
      try {
        await (reaction as MessageReaction).users.remove(user.id);
      } catch (err: any) {
        this.logWarning(guild, "Failed to remove reaction for message (%s)", err?.message ?? err);
      }
    }
  }

  // --- internal helpers --------------------------------------------------

  private async fetchMessage(channel: any, messageId: string): Promise<Message | undefined> {
    if (!channel?.isTextBased?.()) return undefined;
    return channel.messages.cache.get(messageId) ?? (await channel.messages.fetch(messageId).catch(() => undefined));
  }

  private getReactionActions(
    guild: Guild,
    channelId: string,
    messageId: string,
    reaction: string,
    noCreate = false,
  ): RoleActionData | undefined {
    const reactionKey = `${channelId}_${messageId}_${reaction}`;

    const data = this.getData(guild)!;
    if (!data.ReactionActions) data.ReactionActions = {};

    let roleActions: RoleActionData = data.ReactionActions[reactionKey];
    if (!roleActions && !noCreate) {
      roleActions = { Add: [], Remove: [], Toggle: [] };
      data.ReactionActions[reactionKey] = roleActions;
    }

    return roleActions;
  }

  /** Ported from Module:HandleConfig — prunes dead config entries and syncs reactions. */
  private async handleConfig(guild: Guild, config: Record<string, any>): Promise<void> {
    this.logInfo(guild, "Processing roles...");

    const processRole = (
      channelId: string,
      messageId: string,
      reaction: string,
      roleId: string,
      field: "Add" | "Remove" | "Toggle",
    ) => {
      const roleActions = this.getReactionActions(guild, channelId, messageId, reaction)!;
      roleActions[field].push(roleId);
    };

    if (!config.ReactionActions) config.ReactionActions = {};

    let configUpdated = false;
    for (const channelId of Object.keys(config.ReactionActions)) {
      const messageTable = config.ReactionActions[channelId];
      for (const messageId of Object.keys(messageTable)) {
        const reactionTable = messageTable[messageId];
        for (const reaction of Object.keys(reactionTable)) {
          const actions = reactionTable[reaction];
          let hasActions = false;

          if (actions.AddRoles) {
            actions.AddRoles = (actions.AddRoles as string[]).filter((roleId) => {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                processRole(channelId, messageId, reaction, roleId, "Add");
                hasActions = true;
                return true;
              } else {
                this.logWarning(guild, "Role %s not found", roleId);
                configUpdated = true;
                return false;
              }
            });
          }

          if (actions.RemoveRoles) {
            actions.RemoveRoles = (actions.RemoveRoles as string[]).filter((roleId) => {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                processRole(channelId, messageId, reaction, roleId, "Remove");
                hasActions = true;
                return true;
              } else {
                this.logWarning(guild, "Role %s not found", roleId);
                configUpdated = true;
                return false;
              }
            });
          }

          if (actions.ToggleRoles) {
            actions.ToggleRoles = (actions.ToggleRoles as string[]).filter((roleId) => {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                processRole(channelId, messageId, reaction, roleId, "Toggle");
                hasActions = true;
                return true;
              } else {
                this.logWarning(guild, "Role %s not found", roleId);
                configUpdated = true;
                return false;
              }
            });
          }

          if (actions.SendMessage) {
            const roleActions = this.getReactionActions(guild, channelId, messageId, reaction)!;
            roleActions.Message = actions.SendMessage;
            hasActions = true;
          }

          if (!hasActions) {
            delete reactionTable[reaction];
            configUpdated = true;
          }
        }

        if (Object.keys(reactionTable).length === 0) {
          delete messageTable[messageId];
          configUpdated = true;
        }
      }

      if (Object.keys(messageTable).length === 0) {
        delete config.ReactionActions[channelId];
        configUpdated = true;
      }
    }

    this.logInfo(guild, "Adding emojis to concerned messages...");

    // Make sure reactions are present on messages
    for (const channelId of Object.keys(config.ReactionActions)) {
      const messageTable = config.ReactionActions[channelId];
      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.isTextBased()) {
        for (const messageId of Object.keys(messageTable)) {
          const reactionTable = messageTable[messageId];
          const message = await this.fetchMessage(channel as any, messageId);
          if (message) {
            const hasReaction: Record<string, boolean> = {};
            const messageReactions: MessageReaction[] = [];

            for (const reaction of message.reactions.cache.values()) {
              const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? "";
              const emoji = this.bot.getEmojiData(guild, emojiKey);
              if (emoji) {
                hasReaction[emoji.name] = true;
              } else {
                this.logError(guild, "found reaction which does not exist in guild: %s", emojiKey);
              }

              const expectedCount = reaction.me ? 1 : 0;
              if (reaction.count !== expectedCount) {
                messageReactions.push(reaction);
              }
            }

            const reactionToAdd: string[] = [];
            for (const reaction of Object.keys(reactionTable)) {
              const emoji = this.bot.getEmojiData(guild, reaction);
              if (emoji) {
                if (!hasReaction[emoji.name]) reactionToAdd.push(reaction);
              } else {
                this.logError(guild, 'Emoji "%s" does not exist', reaction);
              }
            }

            reactionToAdd.sort((a, b) => {
              const i = emojiOrder[a];
              const j = emojiOrder[b];
              if (i !== undefined && j !== undefined) return i - j;
              return a < b ? -1 : a > b ? 1 : 0;
            });

            for (const reaction of reactionToAdd) {
              const emoji = this.bot.getEmojiData(guild, reaction)!;
              try {
                await message.react(emoji.emoji ?? emoji.id);
              } catch (err: any) {
                this.logWarning(
                  guild,
                  "Failed to add reaction %s on message %s (channel: %s): %s",
                  emoji.name,
                  message.id,
                  channelId,
                  err?.message ?? err,
                );
              }
            }

            // Handle users reactions
            for (const reaction of messageReactions) {
              const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? "";
              const emoji = this.bot.getEmojiData(guild, emojiKey);
              if (emoji) {
                const users = await reaction.users.fetch().catch(() => undefined);
                if (users) {
                  for (const user of users.values()) {
                    if (await this.handleReactionAdd(guild, user.id, channelId, messageId, emoji.name)) {
                      try {
                        await reaction.users.remove(user.id);
                      } catch (err: any) {
                        this.logWarning(guild, "Failed to remove reaction on message (%s)", err?.message ?? err);
                      }
                    }
                  }
                }
              }
            }
          } else {
            this.logError(guild, "Message %s no longer exists in channel %s", messageId, channelId);
            delete messageTable[messageId];
            configUpdated = true;
          }
        }
      } else {
        this.logError(guild, "Channel %s no longer exists", channelId);
        delete config.ReactionActions[channelId];
        configUpdated = true;
      }
    }

    if (configUpdated) {
      await this.saveGuildConfig(guild);
    }
  }

  /** Ported from Module:HandleReactionAdd — applies role/DM actions bound to a reaction. */
  private async handleReactionAdd(
    guild: Guild,
    userId: string,
    channelId: string,
    messageId: string,
    reactionName: string,
  ): Promise<boolean> {
    if (this.bot.client.user?.id === userId) {
      return false;
    }

    const roleActions = this.getReactionActions(guild, channelId, messageId, reactionName, true);
    if (!roleActions) {
      return false;
    }

    let isActive = false;

    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => undefined);
    if (!member) {
      return true;
    }

    for (const roleId of roleActions.Add) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        if (!member.roles.cache.has(role.id)) {
          this.logInfo(guild, "Adding %s%s to %s", role.name, role.color !== 0 ? " (colored)" : "", member.user.tag);

          await member.roles.add(role.id).catch((err: any) => {
            this.logWarning(guild, "Failed to add role %s to %s: %s", role.name, member!.user.tag, err?.message ?? err);
          });
        }

        isActive = true;
      } else {
        this.logWarning(guild, "Role %s appears to have been removed", roleId);
      }
    }

    for (const roleId of roleActions.Remove) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        if (member.roles.cache.has(role.id)) {
          this.logInfo(
            guild,
            "Removing %s%s from %s",
            role.name,
            role.color !== 0 ? " (colored)" : "",
            member.user.tag,
          );

          await member.roles.remove(role.id).catch((err: any) => {
            this.logWarning(
              guild,
              "Failed to remove role %s from %s: %s",
              role.name,
              member!.user.tag,
              err?.message ?? err,
            );
          });
        }

        isActive = true;
      } else {
        this.logWarning(guild, "Role %s appears to have been removed", roleId);
      }
    }

    for (const roleId of roleActions.Toggle) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        const hasRole = member.roles.cache.has(role.id);
        this.logInfo(
          guild,
          "Toggling %s%s (%s) from %s",
          role.name,
          role.color !== 0 ? " (colored)" : "",
          hasRole ? "removing" : "adding",
          member.user.tag,
        );

        const action = hasRole ? member.roles.remove(role.id) : member.roles.add(role.id);
        await action.catch((err: any) => {
          this.logWarning(guild, "Failed to toggle role %s from %s: %s", role.name, member!.user.tag, err?.message ?? err);
        });

        isActive = true;
      } else {
        this.logWarning(guild, "Role %s appears to have been removed", roleId);
      }
    }

    if (roleActions.Message) {
      try {
        await member.user.send(`[From ${guild.name}]\n${roleActions.Message}`);
        isActive = true;
      } catch (err: any) {
        this.logWarning(
          guild,
          "Failed to send reaction message to %s (maybe user disabled private messages from this server?): %s",
          member.user.tag,
          err?.message ?? err,
        );
      }
    }

    return isActive;
  }
}

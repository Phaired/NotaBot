// Ported from module_sentry.lua — silently monitors a configurable list of
// users, posting an alert to a "sentry channel" when they join the server or
// send a message (optionally only when the message contains a keyword).

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType, type ParseResult } from "../core/configTypes";
import { validateSnowflake } from "../util/snowflake";
import type { GuildMember, Message } from "discord.js";

function validateString(str: unknown): ParseResult<boolean> {
  if (typeof str !== "string") return [undefined, " must be a string"];
  if (str.length === 0) return [undefined, " cannot be empty"];
  return [true];
}

export default class SentryModule extends BotModule {
  name = "sentry";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "SentryChannel",
        Description: "Channel where sentry news (monitored users joins and messages) will be posted",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "JoinAlert",
        Description:
          "Message to be posted when a monitored user joins the server (`{userMention}` will be replaced by the user mention, `{userTag}` will be replaced by the user name, `{userId}` will be replaced by the user id)",
        Type: ConfigType.String,
        Default: "The monitored user {userTag} ({userId}) has joined the server",
      },
      {
        Name: "MessageAlert",
        Description:
          "Message to be posted when a monitored user sends a message which contains one of optionally keywords (`{userMention}` will be replaced by the user mention, `{userTag}` will be replaced by the user name, `{userId}` will be replaced by the user id, `{message}` will be replaced by the message link)",
        Type: ConfigType.String,
        Default: "The monitored user {userTag} ({userId}) has sent a message : {message}",
      },
      {
        Name: "MonitoredJoins",
        Description: "The users that the bot should monitor. Alert when a monitored user joins the server.",
        Type: ConfigType.User,
        Default: [],
        Array: true,
      },
      {
        Name: "MonitoredMessages",
        Description:
          "The users that the bot should monitor. Alert when a monitored user sends a message. Map associating a user with keywords.",
        Type: ConfigType.Custom,
        ValidateConfig: (value: any): ParseResult<boolean> => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return [undefined, "MonitoredMessages must be an object"];
          }

          for (const [userId, keywords] of Object.entries(value)) {
            const [validId] = validateSnowflake(userId);
            if (!validId) {
              return [undefined, "MonitoredMessages keys must be user snowflakes"];
            }

            if (!Array.isArray(keywords)) {
              return [undefined, `MonitoredMessages[${userId}] must be an array`];
            }

            for (let i = 0; i < keywords.length; i++) {
              const keyword = keywords[i];
              const [validKeyword, err] = validateString(keyword);
              if (!validKeyword) {
                return [undefined, `MonitoredMessages[${userId}][${i}] (${String(keyword)} ${err})`];
              }
            }
          }

          return [true];
        },
        Default: {},
      },
    ];
  }

  /** Replaces {userMention}/{userTag}/{userId} placeholders (lua CommonMessageGsub). */
  private commonMessageGsub(message: string, member: GuildMember): string {
    const tag = member.user.tag ?? member.user.username;
    return message
      .replaceAll("{userMention}", member.toString())
      .replaceAll("{userTag}", tag)
      .replaceAll("{userId}", member.id);
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const config = this.getConfig(guild);
    if (!config) return;

    const monitoredJoins: string[] = config.MonitoredJoins ?? [];
    if (!config.SentryChannel || !monitoredJoins.includes(member.id)) {
      return;
    }

    const channel = guild.channels.cache.get(config.SentryChannel);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const alert = this.commonMessageGsub(config.JoinAlert, member);
    await channel.send(alert).catch(() => {});
  }

  async onMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!this.bot.isPublicChannel(message.channel as any)) return;

    const guild = message.guild;
    const member = message.member;
    if (!guild || !member) return;

    const config = this.getConfig(guild);
    if (!config) return;

    const monitoredMessages: Record<string, string[]> = config.MonitoredMessages ?? {};
    const keywords = monitoredMessages[member.id];
    if (!keywords || !config.SentryChannel) {
      return;
    }

    const channel = guild.channels.cache.get(config.SentryChannel);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    if (keywords.length !== 0) {
      const content = (message.content ?? "").toLowerCase();
      const matched = keywords.some((keyword) => content.includes(String(keyword).toLowerCase()));
      if (!matched) {
        return;
      }
    }

    let alert = this.commonMessageGsub(config.MessageAlert, member);
    alert = alert.replaceAll("{message}", this.bot.generateMessageLink(message));

    try {
      await channel.send(alert);
    } catch (err) {
      this.logError(guild, "Failed to alert: %s", err);
    }
  }
}

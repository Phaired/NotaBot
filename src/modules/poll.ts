// Ported from module_poll.lua — lets members build and launch simple reaction
// polls, then tallies votes and posts the results once the poll expires.
//
// The original module stores each pending poll as `poll[member.id]` scratch data
// (Module:GetData) while it's being configured with the `poll` command, and once
// `poll send` fires it snapshots a compact array into persistent data
// (`persistentData.runningPolls`) that a 1s repeat timer scans every tick looking
// for expired polls to close out.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { CommandContext, normalizeReply, type ReplyPayload } from "../core/command";
import type { Timer } from "../core/timer";
import type { EmojiData } from "../core/emoji";
import { formatTime, osTime } from "../util/time";
import { PermissionFlagsBits, type Guild, type GuildMember, type Message } from "discord.js";

interface PollChoice {
  emoji: EmojiData;
  text: string;
}

interface PendingPoll {
  title: string;
  channel: string; // channel id
  duration: number;
  choices: PollChoice[];
}

/** What we snapshot into persistent data once a poll is sent (lua's `poll[1..6]` tuple). */
interface RunningPoll {
  memberId: string;
  startedAt: number;
  duration: number;
  channelId: string;
  messageId: string;
  emojiNames: string[]; // stored in the same order as the result embed's fields
}

export default class PollModule extends BotModule {
  name = "poll";

  private timer?: Timer;

  // --- Config ------------------------------------------------------------

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Array: true,
        Name: "AllowedRoles",
        Description: "Roles allowed to create polls",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Array: true,
        Name: "SpecifyChannelAllowedRoles",
        Description: "Roles allowed to specify where to send a poll",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "DefaultPollChannel",
        Description: "Where should polls be sent if no channel is set on init",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "DefaultPollDuration",
        Description: "Default poll duration if no duration is set on init",
        Type: ConfigType.Duration,
        Default: 24 * 60 * 60,
      },
      {
        Name: "DeletePollOnExpiration",
        Description: "Delete original poll message on expiration",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "UseProgressBars",
        Description: "Use progress bars to fancy out results",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "MostVotedRelative",
        Description:
          "Make Progress bars relative to the most voted choice, instead of being relative to total votes",
        Type: ConfigType.Boolean,
        Default: false,
      },
    ];
  }

  // --- Lifecycle -----------------------------------------------------------

  async onUnload(): Promise<void> {
    this.timer?.stop();
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const data = this.getData(guild)!;
    data.Polls = {};
    return true;
  }

  async onLoaded(): Promise<boolean> {
    this.timer = this.bot.createRepeatTimer(1, -1, () => this.checkExpiredPolls());

    this.registerCommand({
      Name: "createpoll",
      Args: [
        { Name: "title", Type: ConfigType.String, Description: "Poll title" },
        { Name: "channel", Type: ConfigType.Channel, Optional: true, Description: "Where to send the poll" },
        { Name: "duration", Type: ConfigType.Duration, Optional: true, Description: "How long the poll should run" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: 'Creates a poll (title format: "title")',
      Func: async (ctx: CommandContext, title: string, channel?: any, duration?: number) => {
        const guild = ctx.guild;
        const member = ctx.member;
        if (!guild || !member) return;

        const data = this.getData(guild)!;
        const polls: Record<string, PendingPoll> = (data.Polls ??= {});
        const config = this.getConfig(guild)!;

        const defaultChannel = config.DefaultPollChannel
          ? guild.channels.cache.get(config.DefaultPollChannel)
          : undefined;
        const pollChannel = channel ?? defaultChannel;
        const pollDuration = duration ?? config.DefaultPollDuration;

        if (!pollChannel) {
          await ctx.reply(
            "You need to either specify a channel, or configure one with the `config poll` command.",
          );
          return;
        }

        if (channel !== undefined && !this.isAllowedToSpecifyChannel(member, config)) {
          await ctx.reply("You are not allowed to specify a channel.");
          return;
        }

        if (!polls[member.id]) {
          polls[member.id] = {
            title,
            channel: pollChannel.id,
            duration: pollDuration,
            choices: [],
          };

          await ctx.reply("Poll created! Set it up using the `poll` command.");
        } else {
          await ctx.reply("You are already setting up a poll.\nUse `cancelpoll` to abort the previous poll.");
        }
      },
    });

    this.registerCommand({
      Name: "cancelpoll",
      Args: [],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Cancels your current pending poll",
      Func: async (ctx: CommandContext) => {
        const guild = ctx.guild;
        const member = ctx.member;
        if (!guild || !member) return;

        const data = this.getData(guild)!;
        const polls: Record<string, PendingPoll> = (data.Polls ??= {});

        if (polls[member.id]) {
          delete polls[member.id];
          await ctx.reply("You can now create a new poll.");
        } else {
          await ctx.reply("You don't have a pending poll.");
        }
      },
    });

    this.registerCommand({
      Name: "poll",
      Args: [
        { Name: "action", Type: ConfigType.String, Description: "add / remove / update / title / send" },
        { Name: "emoji", Type: ConfigType.Emoji, Optional: true, Description: "Emoji tied to the choice" },
        { Name: "text", Type: ConfigType.String, Optional: true, Description: "Choice text / new title" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Sets up a poll",
      Func: async (ctx: CommandContext, action: string, emoji?: EmojiData, text?: string) => {
        const guild = ctx.guild;
        const member = ctx.member;
        if (!guild || !member) return;

        const data = this.getData(guild)!;
        const polls: Record<string, PendingPoll> = (data.Polls ??= {});
        const poll = polls[member.id];

        if (!poll) {
          await ctx.reply("You must create a poll in order to use this command!");
          return;
        }

        if (action === "add") {
          if (poll.choices.length >= 20) {
            await ctx.reply("You can't add more than 20 choices!");
            return;
          }

          if (text === undefined || text === "") {
            await ctx.reply("You can't add a choice without text!");
            return;
          }

          if (emoji !== undefined) {
            if (this.isAChoice(poll, emoji)) {
              await ctx.reply(
                "This emoji is already used for a choice! Can't add it : use `update` action if you want to update it!\n",
              );
              return;
            }

            poll.choices.push({ emoji, text });
          } else {
            await ctx.reply(
              "This emoji is unknown. If it is a Discord one, please contact Lynix for him to update the internal emoji list.",
            );
            return;
          }

          const message = await this.replyWithMessage(ctx, {
            embed: this.formatPoll(member, {}, undefined, true),
          });
          await this.addEmbedReactions(member, message);
          return;
        }

        if (action === "remove") {
          // NOTE: the lua version indexes `emoji.Name`/`emoji.MentionString` here
          // unconditionally, which crashes if `emoji` failed to resolve. We reply
          // with a clarifying error instead of throwing.
          if (emoji === undefined) {
            await ctx.reply("This emoji is unknown, or you didn't specify one.");
            return;
          }

          let reply = "";
          if (text !== undefined) {
            reply += "**WARN** The specified text is useless and will be ignored!\n";
          }

          const before = poll.choices.length;
          poll.choices = poll.choices.filter((choice) => choice.emoji.name !== emoji.name);
          const wasIn = poll.choices.length !== before;

          reply += wasIn
            ? `${emoji.mentionString} has been removed!\n`
            : `${emoji.mentionString} doesn't match any choice. It was not removed.\n`;

          const message = await this.replyWithMessage(ctx, {
            embed: this.formatPoll(member, {}, reply, true),
          });
          await this.addEmbedReactions(member, message);
          return;
        }

        if (action === "update") {
          if (text === undefined) {
            await ctx.reply("Can't update a choice without text! To remove a choice, use the `remove` action.");
            return;
          }
          if (emoji === undefined) {
            await ctx.reply("This emoji is unknown, or you didn't specify one.");
            return;
          }

          let reply = `${emoji.mentionString} text update has failed.`;
          for (const choice of poll.choices) {
            if (choice.emoji.name === emoji.name) {
              choice.text = text;
              reply = `${emoji.mentionString} text updated successfully.`;
              break;
            }
          }

          const message = await this.replyWithMessage(ctx, {
            embed: this.formatPoll(member, {}, reply, true),
          });
          await this.addEmbedReactions(member, message);
          return;
        }

        if (action === "title") {
          if (text === undefined) {
            await ctx.reply("Invalid title! No title set!");
            return;
          }

          poll.title = text;
          await ctx.reply(`Title set to \`${text}\``);
          return;
        }

        if (action === "send") {
          if (poll.choices.length < 2) {
            await ctx.reply("You can't send a poll without at least 2 choices! Set some using the `add` action!");
            return;
          }

          const channel = guild.channels.cache.get(poll.channel) as any;
          if (!channel || typeof channel.send !== "function") {
            await ctx.reply("The channel configured for this poll no longer exists.");
            return;
          }

          const persistentData = this.getPersistentData(guild)!;
          const message: Message = await channel.send(
            normalizeReply({ embed: this.formatPoll(member, {}, undefined, false) }),
          );
          await this.addEmbedReactions(member, message);

          const runningPolls: RunningPoll[] = (persistentData.runningPolls ??= []);
          const emojiNames = poll.choices.map((choice) => choice.emoji.name);

          runningPolls.push({
            memberId: member.id,
            startedAt: osTime(),
            duration: poll.duration,
            channelId: channel.id,
            messageId: message.id,
            emojiNames,
          });

          delete polls[member.id];

          await ctx.reply(`Poll successfully sent to ${channel.toString()} (#${channel.name}).`);
          return;
        }

        await ctx.reply("Invalid action. It can only be `add`, `remove`, `update`, `title` or `send`.");
      },
    });

    return true;
  }

  // --- Permissions -----------------------------------------------------------

  private memberHasAnyRole(member: GuildMember, roleIds: string[] | undefined): boolean {
    if (!roleIds || roleIds.length === 0) return false;
    return roleIds.some((id) => member.roles.cache.has(id));
  }

  private checkPermissions(member: GuildMember | null): boolean {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const config = this.getConfig(member.guild);
    return this.memberHasAnyRole(member, config?.AllowedRoles);
  }

  private isAllowedToSpecifyChannel(member: GuildMember, config: Record<string, any>): boolean {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return this.memberHasAnyRole(member, config.SpecifyChannelAllowedRoles);
  }

  private isAChoice(poll: PendingPoll, emoji: EmojiData): boolean {
    return poll.choices.some((choice) => choice.emoji.id === emoji.id);
  }

  // --- Reply helper ------------------------------------------------------

  /**
   * Like `ctx.reply`, but also returns the resulting Message so callers can
   * react to it (the lua code does `message = commandMessage:reply(...)` then
   * adds reactions on the returned message). `CommandContext.reply` doesn't
   * expose the created message for the slash path, so this fetches it back
   * via the interaction API instead.
   */
  private async replyWithMessage(ctx: CommandContext, payload: ReplyPayload): Promise<Message | undefined> {
    const options = normalizeReply(payload);
    if (ctx.interaction) {
      if (ctx.interaction.replied || ctx.interaction.deferred) {
        return (await ctx.interaction.followUp(options)) as Message;
      }
      await ctx.interaction.reply(options);
      return (await ctx.interaction.fetchReply().catch(() => undefined)) as Message | undefined;
    }
    if (ctx.message) {
      return await ctx.message.reply(options);
    }
    return undefined;
  }

  private async addEmbedReactions(member: GuildMember, message: Message | undefined): Promise<void> {
    if (!message) return;

    const data = this.getData(member.guild)!;
    const poll: PendingPoll | undefined = data.Polls?.[member.id];
    if (!poll || poll.choices.length === 0) return;

    for (const choice of poll.choices) {
      if (!choice.emoji) continue;
      const reactable = choice.emoji.custom ? choice.emoji.emoji ?? choice.emoji.id : choice.emoji.id;
      await message.react(reactable).catch(() => {});
    }
  }

  // --- Formatting --------------------------------------------------------

  private formatChoiceResult(choiceVotes: number, barScale: number, totalVotes: number, asProgressBars: boolean): string {
    const voteText = choiceVotes > 1 ? "votes" : "vote";

    if (asProgressBars) {
      const progressLength = 20; // length (in characters) of the progress bar
      const progressCharacter = "=";
      const ratio = barScale > 0 ? choiceVotes / barScale : 0;
      const choiceProgressLength = Math.floor(ratio * progressLength);

      const progressText =
        progressCharacter.repeat(choiceProgressLength) + " ".repeat(progressLength - choiceProgressLength);
      const percentage = totalVotes > 0 ? Math.floor((choiceVotes / totalVotes) * 100) : 0;

      return `\`[${progressText}]\` **${choiceVotes}**   ${voteText} (${percentage}%)`;
    }

    return `**${choiceVotes}** ${voteText}`;
  }

  private getPollFooter(member: GuildMember, duration: number | undefined, isResults = false): string {
    let text = `Poll requested by ${member.user.tag}`;

    if (duration === undefined) return text;

    const verb = isResults ? "Lasted" : "Lasts";
    if (duration < 60) duration = 60;

    text = `${text}. ${verb} for ${formatTime(duration)}.`;
    return text;
  }

  /** Ported from Module:FormatPoll. Mutates and returns `embed`. */
  private formatPoll(member: GuildMember, embed: any, footer: string | undefined, preview: boolean): any {
    const guild = member.guild;
    const data = this.getData(guild)!;
    const polls: Record<string, PendingPoll> = (data.Polls ??= {});
    const poll = polls[member.id];

    const fields: { name: string; value: string }[] = [];
    const title = preview ? `[Preview] ${poll.title}` : poll.title;

    for (let i = 0; i < poll.choices.length; i++) {
      const choice = poll.choices[i];
      if (this.bot.getEmojiData(guild, choice.emoji.name)) {
        fields.push({
          name: `Choice n°${i + 1}`,
          value: `${choice.emoji.mentionString}  ${choice.text}`,
        });
      } else {
        // Deinit the poll
        delete polls[member.id];
        this.logInfo(guild, "An emoji was deleted during the configuration of a poll that was using it.");

        return {
          title: "An emoji is broken.",
          fields: [
            {
              name: "This is not a bot error.",
              value: "This happens when an emoji in the poll is deleted during its configuration.",
            },
            {
              name: "How to fix it?",
              value: "You can't! Your poll has been cancelled.",
            },
            {
              name: "What to do now?",
              value: "Just use the command `createpoll` and redo everything.",
            },
          ],
        };
      }
    }

    embed.title = title;
    embed.fields = fields;

    if (footer !== undefined) {
      embed.footer = { text: footer };
    } else {
      embed.footer = { text: this.getPollFooter(member, poll.duration) };
    }

    return embed;
  }

  // --- Expiration timer --------------------------------------------------

  private checkExpiredPolls(): void {
    const now = osTime();

    this.forEachGuild((_guildId, config, _data, persistentData, guild) => {
      if (!guild) return;

      const runningPolls: RunningPoll[] | undefined = persistentData.runningPolls;
      if (!runningPolls) return;

      // Rebuild the list rather than mutating it while iterating (the lua
      // original does `table.remove` mid-`ipairs`, which can skip an entry
      // when two polls expire on the same tick — harmless there since the
      // timer re-scans every second, but easy to avoid entirely here).
      const remaining: RunningPoll[] = [];
      for (const entry of runningPolls) {
        if (now < entry.startedAt + entry.duration) {
          remaining.push(entry);
          continue;
        }

        this.finalizePoll(guild, config, entry).catch((e) =>
          this.logWarning(guild, "Failed to finalize poll: %s", e?.stack ?? e),
        );
      }
      persistentData.runningPolls = remaining;
    });
  }

  private async finalizePoll(guild: Guild, config: Record<string, any>, entry: RunningPoll): Promise<void> {
    const channel = guild.channels.cache.get(entry.channelId) as any;
    let member = guild.members.cache.get(entry.memberId);
    if (!member) member = await guild.members.fetch(entry.memberId).catch(() => undefined);

    if (!channel || !member || typeof channel.send !== "function") return;

    const message: Message | undefined = await channel.messages.fetch(entry.messageId).catch(() => undefined);
    if (!message) return;

    let totalVotes = 0;
    let mostVotedCount = 0;
    const map: { count: number; title: string }[] = [];

    const fields = message.embeds[0]?.fields ?? [];
    const emojiNames = entry.emojiNames; // stored in the same order as `fields`

    for (const reaction of message.reactions.cache.values()) {
      const key = reaction.emoji.id ?? reaction.emoji.name ?? "";
      const rEmojiData = this.bot.getEmojiData(guild, key);
      // This is null when it is an external emoji we don't track.
      if (!rEmojiData) break;

      for (let i = 0; i < emojiNames.length; i++) {
        if (rEmojiData.name === emojiNames[i]) {
          const choiceVotes = (reaction.count ?? 0) - 1;

          map.push({ count: choiceVotes, title: fields[i]?.value ?? "" });

          if (choiceVotes > mostVotedCount) mostVotedCount = choiceVotes;
          totalVotes += choiceVotes;
          break;
        }
      }
    }

    if (fields.length < map.length) {
      this.logWarning(guild, "Poll result field/vote count mismatch (fields=%d, map=%d)", fields.length, map.length);
    } else if (fields.length > map.length) {
      for (const field of fields) {
        const wasIn = map.some((m) => m.title === field.value);
        if (!wasIn) {
          map.push({ count: 0, title: `${field.value} *(**deleted**)*` });
        }
      }
    }

    const results: any = {
      author: { name: "Poll results", icon_url: member.user.displayAvatarURL() },
      title: message.embeds[0]?.title,
      fields: [] as { name: string; value: string }[],
      footer: { text: this.getPollFooter(member, entry.duration, true) },
    };

    map.sort((a, b) => b.count - a.count);

    const barScale = config.MostVotedRelative ? mostVotedCount : totalVotes;

    for (const choice of map) {
      results.fields.push({
        name: choice.title,
        value: this.formatChoiceResult(choice.count, barScale, totalVotes, config.UseProgressBars),
      });
    }

    if (!config.DeletePollOnExpiration) {
      results.url = this.bot.generateMessageLink(message);
    }

    await channel.send(normalizeReply({ embed: results })).catch(() => {});

    if (config.DeletePollOnExpiration) {
      const deleted = await message.delete().then(
        () => true,
        () => false,
      );
      if (!deleted) {
        await channel.send("**ERROR** Failed to delete original poll message!").catch(() => {});
      }
    }
  }
}

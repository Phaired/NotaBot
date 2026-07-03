// Ported from module_purge.lua — kicks/clears roles from members who haven't
// been active (message/reaction) for a configurable duration.
//
// Note on error handling: discordia's HTTP-backed calls (Channel:send,
// Member:removeRole, Member:kick, User:getPrivateChannel) return `nil, err` on
// failure instead of throwing, and the original lua never checked those return
// values. discord.js instead rejects the promise, so every one of those calls
// below is wrapped in `.catch(() => {})` to reproduce the lua's "ignore and
// keep going" behavior (otherwise a single failed DM/kick/role-removal would
// abort the whole purge loop, which the original never did).

import { BotModule } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { formatTime, osTime } from "../util/time";
import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from "discord.js";

export default class PurgeModule extends BotModule {
  name = "purge";

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "drypurge",
      Args: [{ Name: "time", Type: ConfigType.Duration, Description: "Inactivity duration (e.g. 30d)" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Count inactive people. Use: !drypurgeroles 30d to count inactive people for 30 days or more.",
      Func: async (ctx, time: number) => {
        const durationStr = formatTime(time, 3);
        const guild = ctx.guild!;
        const userList = this.buildInactiveUsersList(guild, time);

        if (userList.length === 0) {
          await ctx.reply("No user enought inactive to be purged");
        } else {
          await ctx.reply(
            `Purging peoples inactive for ${durationStr} on Discord will remove all roles on (or kick) ${userList.length} members. Are you sure ? (type !purgeroles ${time} to apply purge by roles, or !purgekick ${time} to kick all inactives members.)`,
          );
        }
      },
    });

    this.registerCommand({
      Name: "purgeroles",
      Args: [{ Name: "time", Type: ConfigType.Duration, Description: "Inactivity duration (e.g. 30d)" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Clear roles on inactive people to make them avaiable to purge. Use: !purgeroles 30d to remove all roles on members inactive for 30 days or more.",
      Func: async (ctx, time: number) => {
        const durationStr = formatTime(time, 3);
        const guild = ctx.guild!;
        const userList = this.buildInactiveUsersList(guild, time);

        if (userList.length === 0) {
          await ctx.reply("No member to purge");
        } else {
          await this.purgeRoles(guild, userList);
          await ctx.reply(`Purged peoples inactive for ${durationStr} on Discord, removed all roles on ${userList.length} members.`);
        }
      },
    });

    this.registerCommand({
      Name: "purgekick",
      Args: [{ Name: "time", Type: ConfigType.Duration, Description: "Inactivity duration (e.g. 30d)" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Kick inactive people. Use: !purgekick 30d to kick all inactive people for 30 days or more.",
      Func: async (ctx, time: number) => {
        const durationStr = formatTime(time, 3);
        const guild = ctx.guild!;
        const userList = this.buildInactiveUsersList(guild, time);

        if (userList.length === 0) {
          await ctx.reply("No member to purge");
        } else {
          await this.purgeKick(guild, userList, durationStr);
          await ctx.reply(`Purged peoples inactive for ${durationStr} on this server, kicked ${userList.length} members.`);
        }
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const data = this.getPersistentData(guild)!;
    if (!data.Purge) {
      this.logInfo(guild, "No previous purge data found, resetting...");
      data.Purge = {};
    } else {
      this.logInfo(guild, "Previous purge data data has been found, continuing...");
    }

    this.addMissingMembersToList(guild);

    return true;
  }

  // --- helpers (ported 1:1 from the lua Module: methods) ----------------------

  private getPurgeMap(guild: Guild): Record<string, number> {
    const data = this.getPersistentData(guild)!;
    if (!data.Purge) data.Purge = {};
    return data.Purge;
  }

  private buildInactiveUsersList(guild: Guild, time: number): GuildMember[] {
    const userList: GuildMember[] = [];

    const purgeData = this.getPurgeMap(guild);

    const allowedInactiveTime = osTime() - time;
    for (const [userId, member] of guild.members.cache) {
      const lastSeen = purgeData[userId];
      if (lastSeen !== undefined && lastSeen < allowedInactiveTime) {
        userList.push(member);
      }
    }

    return userList;
  }

  private async purgeRoles(guild: Guild, userList: GuildMember[]): Promise<void> {
    if (userList.length === 0) return;

    this.logInfo(guild, "Begining role purge");

    for (const member of userList) {
      this.logInfo(guild, "Purging roles for %s", member.displayName);

      for (const role of [...member.roles.cache.values()]) {
        // discordia's `Member.roles` doesn't include the @everyone role; skip it
        // here too since it can't be removed via the role-remove endpoint.
        if (role.id === guild.id) continue;
        // You can't remove managed roles (e.g. bot/integration roles), Discord
        // sends a 403 if you try.
        if (role.managed) continue;
        await member.roles.remove(role.id).catch(() => {});
      }
    }

    this.logInfo(guild, "Role purge ended !");
  }

  private async purgeKick(guild: Guild, userList: GuildMember[], durationStr: string): Promise<void> {
    if (userList.length === 0) return;

    const kickPrivateMessage = `You've been kicked by an automatic measure from **${guild.name}** because of an inactivity of **${durationStr}** or more.`;

    this.logInfo(guild, "Begining purge");

    for (const member of userList) {
      this.logInfo(guild, "Kicking %s", member.displayName);

      await member.send(kickPrivateMessage).catch(() => {});
      await member.kick("Inactive").catch(() => {});
    }

    this.logInfo(guild, "Purge ended !");
  }

  private addMissingMembersToList(guild: Guild): void {
    const purgeData = this.getPurgeMap(guild);

    for (const [userId] of guild.members.cache) {
      if (purgeData[userId] === undefined) {
        purgeData[userId] = osTime();
      }
    }
  }

  // --- activity tracking (ported from the lua OnXxx hooks) --------------------

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) return;
    if (!message.guild) return;

    this.getPurgeMap(message.guild)[message.author.id] = osTime();
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    this.getPurgeMap(member.guild)[member.id] = osTime();
  }

  // The lua module had separate OnReactionAdd/OnReactionAddUncached (and the
  // Remove equivalents) because discordia only fires the "cached" event when
  // the message/reaction is already in memory. discord.js unifies both cases
  // into a single event backed by partials (see core/client.ts), so a partial
  // reaction is fetched here instead of needing a second handler.
  async onMessageReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    await this.trackReactionActivity(reaction, user);
  }

  async onMessageReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    await this.trackReactionActivity(reaction, user);
  }

  private async trackReactionActivity(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return;
      }
    }

    if (!this.bot.isPublicChannel(reaction.message.channel as any)) return;

    const guild = reaction.message.guild;
    if (!guild) return;

    this.getPurgeMap(guild)[user.id] = osTime();
  }
}

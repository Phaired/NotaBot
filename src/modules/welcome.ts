// Ported from module_welcome.lua — posts join/leave/ban/unban messages and
// grants join roles to new members.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import type { GuildBan, GuildMember, User } from "discord.js";

export default class WelcomeModule extends BotModule {
  name = "welcome";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "WelcomeChannel",
        Description: "Channel where join/leave will be posted",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "BanChannel",
        Description: "Channel where ban/unban will be posted",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "JoinMessage",
        Description:
          "Message to be posted when a user joins the server (`{userMention}` will be replaced by the user mention string)",
        Type: ConfigType.String,
        Default: "Welcome to {userMention}!",
        Optional: true,
      },
      {
        Name: "JoinRoles",
        Description: "Roles to give to new members (up to 10)",
        Type: ConfigType.Role,
        Optional: true,
        Array: true,
        ArrayMaxSize: 10,
      },
      {
        Name: "LeaveMessage",
        Description:
          "Message to be posted when a user leaves the server (`{userTag}` will be replaced by the user name)",
        Type: ConfigType.String,
        Default: "Farewell {userTag}. :wave:",
        Optional: true,
      },
      {
        Name: "BanMessage",
        Description:
          "Message to be posted when a user is banned from the server (`{userTag}` will be replaced by the user name)",
        Type: ConfigType.String,
        Default: "{userTag} has been banned. :hammer:",
        Optional: true,
      },
      {
        Name: "UnbanMessage",
        Description:
          "Message to be posted when a user is unbanned from the server (`{userTag}` will be replaced by the user name)",
        Type: ConfigType.String,
        Default: "{userTag} has been unbanned.",
        Optional: true,
      },
    ];
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const config = this.getConfig(guild);
    if (!config?.WelcomeChannel) return;

    const channel = guild.channels.cache.get(config.WelcomeChannel) as any;
    const message = config.JoinMessage;
    if (channel && message) {
      let finalMessage = this.commonMessageGsub(message, member.user);
      finalMessage = finalMessage.split("{user}").join(member.user.toString());

      await channel.send(finalMessage).catch(() => {});
    }

    if (config.JoinRoles) {
      for (const roleId of config.JoinRoles as string[]) {
        const role = guild.roles.cache.get(roleId);
        if (role) {
          try {
            await member.roles.add(role);
          } catch (err: any) {
            this.logError(
              guild,
              "Failed to add role %s to member %s: %s",
              role.name,
              member.user.tag ?? "<invalid>",
              err?.message ?? err,
            );
          }
        } else {
          this.logError(guild, "Invalid role %s", roleId);
        }
      }
    }
  }

  async onGuildMemberRemove(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const config = this.getConfig(guild);
    if (!config?.WelcomeChannel) return;

    const channel = guild.channels.cache.get(config.WelcomeChannel) as any;
    const message = config.LeaveMessage;
    if (!channel || !message) return;

    let finalMessage = this.commonMessageGsub(message, member.user);
    finalMessage = finalMessage.split("{user}").join(member.user.tag ?? member.user.username);

    if (member.joinedTimestamp) {
      const durationSeconds = Math.max(0, Math.floor((Date.now() - member.joinedTimestamp) / 1000));
      finalMessage = finalMessage.split("{duration}").join(this.bot.formatDuration(guild, durationSeconds, 2));
    } else {
      finalMessage = finalMessage.split("{duration}").join("<unavailable>");
    }

    await channel.send(finalMessage).catch(() => {});
  }

  async onGuildBanAdd(ban: GuildBan): Promise<void> {
    const guild = ban.guild;
    const user = ban.user;
    const config = this.getConfig(guild);
    if (!config?.BanChannel) return;

    const channel = guild.channels.cache.get(config.BanChannel) as any;
    const message = config.BanMessage;
    if (channel && message) {
      let finalMessage = this.commonMessageGsub(message, user);
      finalMessage = finalMessage.split("{user}").join(user.tag ?? user.username);

      await channel.send(finalMessage).catch(() => {});
    }
  }

  async onGuildBanRemove(ban: GuildBan): Promise<void> {
    const guild = ban.guild;
    const user = ban.user;
    const config = this.getConfig(guild);
    if (!config?.BanChannel) return;

    const channel = guild.channels.cache.get(config.BanChannel) as any;
    const message = config.UnbanMessage;
    if (channel && message) {
      let finalMessage = this.commonMessageGsub(message, user);
      finalMessage = finalMessage.split("{user}").join(user.tag ?? user.username);

      await channel.send(finalMessage).catch(() => {});
    }
  }

  private commonMessageGsub(message: string, user: User): string {
    let result = message.split("{userTag}").join(user.tag ?? user.username);
    result = result.split("{userMention}").join(user.toString());
    return result;
  }
}

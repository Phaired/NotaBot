// Ported from module_kick.lua — lets moderators kick a member via `!kick`/`/kick`.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";

export default class KickModule extends BotModule {
  name = "kick";

  checkPermissions(member: GuildMember | null): boolean {
    if (!member) return false;
    const config = this.getConfig(member.guild);
    const authorizedRoles: string[] = config?.AuthorizedRoles ?? [];
    for (const roleId of authorizedRoles) {
      if (member.roles.cache.has(roleId)) return true;
    }
    return member.permissions.has(PermissionFlagsBits.KickMembers);
  }

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "PrivateMessage",
        Description:
          "If set, the bot will try to send a private message before kicking the user.\nAvailable variables: {guild}, {user}, {reason}.",
        Type: ConfigType.String,
        Default: "You have been kicked from {guild} by {user}: {reason}",
        Optional: true,
      },
      {
        Name: "AuthorizedRoles",
        Description: "Roles which can use the kick command (not required if user/role has kick member permission)",
        Type: ConfigType.Role,
        Default: [],
        Array: true,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "kick",
      Args: [
        { Name: "target", Type: ConfigType.Member, Description: "Member to kick" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason for the kick" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Kicks a member",
      Silent: true,
      Func: async (ctx, targetMember: GuildMember, reason?: string) => {
        const guild = ctx.guild as Guild;
        const config = this.getConfig(guild)!;
        const kickedBy = ctx.member as GuildMember;

        // Permission check: can't kick someone with an equal or higher role.
        const kickedByRole = kickedBy.roles.highest;
        const targetRole = targetMember.roles.highest;
        if (targetRole.position >= kickedByRole.position) {
          await ctx.reply("You cannot kick that user due to your lower permissions.");
          return;
        }

        if (config.PrivateMessage) {
          let message: string = config.PrivateMessage;
          message = message
            .replaceAll("{guild}", guild.name)
            .replaceAll("{user}", kickedBy.toString())
            .replaceAll("{reason}", reason || "no reason given");

          await targetMember.user.send(message).catch(() => {});
        }

        const kickReason = `Kicked by ${kickedBy.toString()}${reason ? `: ${reason}` : ""}`;
        try {
          await targetMember.kick(kickReason);
          await ctx.reply(`${ctx.author.tag} has kicked ${targetMember.user.tag}${reason ? `: ${reason}` : ""}`);
        } catch {
          await ctx.reply(`Failed to kick ${targetMember.user.tag}`);
        }
      },
    });

    return true;
  }
}

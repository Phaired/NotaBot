// Ported from module_roleinfo.lua — prints information about matching roles.

import { BotModule } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { EmbedBuilder, PermissionFlagsBits, type Role } from "discord.js";

export default class RoleInfoModule extends BotModule {
  name = "roleinfo";

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "roleinfo",
      Args: [{ Name: "rolename", Type: ConfigType.String, Description: "Role name, or p:<pattern> for regex" }],
      PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
      Help: "Prints role info",
      Func: async (ctx, rolenameArg) => {
        const rolename = String(rolenameArg).toLowerCase();
        let roleRegex: RegExp | undefined;
        if (rolename.startsWith("p:")) {
          try {
            roleRegex = new RegExp(rolename.slice(2));
          } catch {
            return ctx.reply("Invalid pattern");
          }
        }

        const guild = ctx.guild!;
        const messages: { embed: EmbedBuilder; order: number }[] = [];

        const processRole = (role: Role) => {
          const hex = role.hexColor.replace("#", "");
          const fields = [
            { name: "ID", value: role.id, inline: true },
            { name: "Name", value: role.toString(), inline: true },
            { name: "Created", value: `<t:${Math.floor(role.createdTimestamp / 1000)}:f>`, inline: true },
            { name: "Color", value: role.hexColor, inline: true },
            { name: "Managed by integration", value: String(role.managed), inline: true },
            { name: "Member count", value: String(role.members.size), inline: true },
            { name: "Mentionable", value: String(role.mentionable), inline: true },
            { name: "Priority", value: String(role.position), inline: true },
            { name: "Shown separate", value: String(role.hoist), inline: true },
          ];
          const embed = new EmbedBuilder()
            .setColor(role.color || null)
            .addFields(fields)
            .setImage(`https://dummyimage.com/320x80/36393f/${hex}.png&text=${encodeURIComponent(role.name)}`);
          messages.push({ embed, order: role.position });
        };

        for (const role of guild.roles.cache.values()) {
          const name = role.name.toLowerCase();
          if (roleRegex ? roleRegex.test(name) : name === rolename) processRole(role);
        }

        messages.sort((a, b) => b.order - a.order);
        if (messages.length === 0) return ctx.reply("No role found.");
        for (const data of messages) await ctx.reply({ embeds: [data.embed] });
      },
    });
    return true;
  }
}

// Ported from module_userinfo.lua — prints info about a user/member.

import { BotModule } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { GatewayIntentBits, type GuildMember, type Role, type User } from "discord.js";

// We have to precede special chars with a `\` to prevent discord from
// replacing them with the corresponding emoji (:<color>_circle:).
const discordStatus: Record<string, string> = {
  online: "\\🟢 Online",
  dnd: "\\🔴 Do Not Disturb",
  idle: "\\🟡 Idle",
  offline: "\\⚪ Offline",
};

const DEFAULT_COLOR = 0; // Default color value, 0 == black
const JOIN_ORDER_WINDOW = 7; // Number of members to show in "Join order" field

// The highest role with color ~= black defines the color of the username.
function getMemberColor(sortedRoles: Role[]): number {
  for (const role of sortedRoles) {
    if (role.color !== DEFAULT_COLOR) return role.color;
  }
  return DEFAULT_COLOR;
}

function buildUserEmbed(user: User) {
  const fullName = user.tag;
  const createdAt = Math.floor(user.createdTimestamp / 1000);

  const description = `__Fullname:__ \`${fullName}\`\n__Created at:__ <t:${createdAt}:f>`;

  return {
    title: `${user.tag} (${user.id})`,
    description,
  };
}

function buildMemberEmbed(member: GuildMember, hasGuildPresencesIntent: boolean) {
  const fullName = member.user.tag;
  const createdAt = Math.floor(member.user.createdTimestamp / 1000);
  const joinedAt = Math.floor((member.joinedTimestamp ?? Date.now()) / 1000);

  let description: string;
  if (hasGuildPresencesIntent) {
    const status = member.presence?.status ?? "offline";
    const presence = discordStatus[status] ?? discordStatus.offline;
    description =
      `__\`Fullname:\`__ \`${fullName}\`\n` +
      `__\`Nickname:\`__ \`${member.displayName}\`\n` +
      `__\`Presence:\`__ ${presence}\n` +
      `__\`Created at:\`__ <t:${createdAt}:f>\n` +
      `__\`Joined  at:\`__ <t:${joinedAt}:f>`;
  } else {
    description =
      `__\`Fullname:\`__ \`${fullName}\`\n` +
      `__\`Nickname:\`__ \`${member.displayName}\`\n` +
      `__\`Created at:\`__ <t:${createdAt}:f>\n` +
      `__\`Joined  at:\`__ <t:${joinedAt}:f>`;
  }

  const fields: { name: string; value: string }[] = [];

  // discord.js's GuildMember.roles.cache always includes the implicit
  // @everyone role; discordia's member.roles never did, so filter it out to
  // match the original behavior/ordering (cannot rely on Collection order).
  const roles = [...member.roles.cache.values()]
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position);

  if (roles.length > 0) {
    const roleNames = roles.map((r) => `\`${r.name}\``);
    fields.push({ name: "Roles", value: roleNames.join(", ") });
  }

  const guildMembers = [...member.guild.members.cache.values()].sort(
    (a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0),
  );

  const memberLines: string[] = [];
  let position = 0;
  guildMembers.forEach((v, idx) => {
    const k = idx + 1; // Lua arrays are 1-indexed
    if (member.id === v.id) {
      memberLines.push(`${k}.\t> ${v.user.tag}`);
      position = k;
    } else {
      memberLines.push(`${k}.\t  ${v.user.tag}`);
    }
  });

  let windowedLines = memberLines;
  if (memberLines.length > JOIN_ORDER_WINDOW) {
    let first = Math.floor(JOIN_ORDER_WINDOW / 2 - 0.5);
    const last = Math.floor(JOIN_ORDER_WINDOW / 2 - 0.5);

    if (position - first < 1) first = 0;

    const start = position - first; // 1-based, inclusive
    const end = Math.min(position + last, memberLines.length); // 1-based, inclusive
    windowedLines = memberLines.slice(start - 1, end);
  }

  fields.push({ name: "Join order", value: "```text\n" + windowedLines.join("\n") + "\n```" });

  return {
    title: `${fullName} (${member.id})`,
    thumbnail: { url: member.user.displayAvatarURL() },
    description,
    fields,
    color: getMemberColor(roles),
  };
}

export default class UserInfoModule extends BotModule {
  name = "userinfo";

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "userinfo",
      Args: [
        {
          Name: "target",
          Type: ConfigType.String,
          Optional: true,
          Description: "User mention/id, or member of this server",
        },
      ],
      Help: "Prints user/member info",

      Func: async (ctx, targetUserId?: string) => {
        // Privileged intent, must be checked before use.
        const hasGuildPresencesIntent = this.bot.client.options.intents.has(GatewayIntentBits.GuildPresences);

        if (!targetUserId) {
          return ctx.reply({ embed: buildMemberEmbed(ctx.member!, hasGuildPresencesIntent) });
        }

        const guild = ctx.guild;
        const [targetMember, err] = await this.bot.decodeMember(guild, targetUserId);

        if (targetMember) {
          return ctx.reply({ embed: buildMemberEmbed(targetMember, hasGuildPresencesIntent) });
        } else if (err === "Invalid user id") {
          return ctx.reply(err);
        } else {
          // Not a member of this guild, trying to get info of the user
          const [targetUser, userErr] = await this.bot.decodeUser(targetUserId);

          if (targetUser) {
            return ctx.reply({ embed: buildUserEmbed(targetUser) });
          } else {
            return ctx.reply(userErr!);
          }
        }
      },
    });

    return true;
  }
}

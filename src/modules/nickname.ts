// Ported from module_nickname.lua — bulk-review/remove custom nicknames on a
// guild ("nuke" every custom nickname, or manage them one by one via buttons).

import { BotModule } from "../core/module";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
} from "discord.js";

const CUSTOM_ID_REMOVE = "nickname_remove_";
const CUSTOM_ID_PAGE = "nickname_page_";

export default class NicknameModule extends BotModule {
  name = "nickname";

  /** Lua `Module.PageSize = 3`. */
  private readonly pageSize = 3;

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "drynukerename",
      Args: [],
      PrivilegeCheck: (member) => this.checkRoles(member),
      Help: "Count every user that have a custom nickname on the server.",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const userList = this.buildRenamedUserList(guild);

        if (userList.length === 0) {
          await ctx.reply("No renamed user");
        } else {
          await ctx.reply(
            `This will remove custom nickname for ${userList.length} members. Are you sure ? Type !nukerename to apply.`,
          );
        }
      },
    });

    this.registerCommand({
      Name: "nukerename",
      Args: [],
      PrivilegeCheck: (member) => this.checkRoles(member),
      Help: "Remove every custom nickname of every user on the server.",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const userList = this.buildRenamedUserList(guild);

        if (userList.length === 0) {
          await ctx.reply("No renamed user");
        } else {
          await this.removeNicknames(guild, ctx.member!, userList);
          await ctx.reply(`Removing custom nickname for ${userList.length} members.`);
        }
      },
    });

    this.registerCommand({
      Name: "managenicknames",
      Args: [],
      PrivilegeCheck: (member) => this.checkRoles(member),
      Help: "Display user nicknames and a button to reset them.",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const userList = this.buildRenamedUserList(guild);

        if (userList.length === 0) {
          await ctx.reply("No renamed user");
        } else {
          await ctx.reply(this.buildUserListMessage(guild, userList, 0));
        }
      },
    });

    // Lua `Module:OnInteractionCreate` routed by custom_id prefix. The framework's
    // interaction router (this.bot.interactions) does the prefix dispatch for us;
    // it is not gated by module-enabled state the way discordjs-event hooks are,
    // so `prepareInteraction` re-checks `isEnabledForGuild` to match the implicit
    // gating the lua module got from bot_modules.lua.
    this.bot.interactions.registerComponent(CUSTOM_ID_REMOVE, async (interaction) => {
      if (!interaction.isButton()) return;
      const prepared = await this.prepareInteraction(interaction);
      if (!prepared) return;
      const { member, userList } = prepared;

      const cmdUserId = interaction.customId.slice(CUSTOM_ID_REMOVE.length);
      const target = userList.find((user) => user.id === cmdUserId);
      if (target) {
        if (!this.hasHighestRolesThanTarget(member, target)) {
          await interaction
            .reply({ content: "You cannot rename that user due to your lower permissions.", ephemeral: true })
            .catch(() => {});
          return;
        }

        await target.setNickname("").catch(() => {});
      }

      await interaction.reply({ content: "Done !", ephemeral: true }).catch(() => {});
    });

    this.bot.interactions.registerComponent(CUSTOM_ID_PAGE, async (interaction) => {
      if (!interaction.isButton()) return;
      const prepared = await this.prepareInteraction(interaction);
      if (!prepared) return;
      const { guild, userList } = prepared;

      const page = Number(interaction.customId.slice(CUSTOM_ID_PAGE.length));
      await interaction
        .update(this.buildUserListMessage(guild, userList, Number.isFinite(page) ? page : 0))
        .catch(() => {});
    });

    return true;
  }

  async onEnable(_guild: Guild): Promise<boolean> {
    return true;
  }

  private checkRoles(member: GuildMember | null): boolean {
    return !!member?.permissions.has(PermissionFlagsBits.ManageNicknames);
  }

  /** Lua `Module:HasHighestRolesThanTarget` — true if `user`'s top role outranks `target`'s. */
  private hasHighestRolesThanTarget(user: GuildMember, target: GuildMember): boolean {
    const userRole = user.roles.highest;
    const targetRole = target.roles.highest;
    if (targetRole.position >= userRole.position) return false;
    return true;
  }

  private async prepareInteraction(
    interaction: ButtonInteraction,
  ): Promise<{ guild: Guild; member: GuildMember; userList: GuildMember[] } | null> {
    const guild = interaction.guild;
    if (!guild) return null;

    const member = interaction.member as GuildMember | null;
    if (!this.checkRoles(member)) return null;
    if (!this.isEnabledForGuild(guild)) return null;

    const userList = this.buildRenamedUserList(guild);
    if (userList.length === 0) {
      await interaction.reply({ content: "No renamed user", ephemeral: true }).catch(() => {});
      return null;
    }

    return { guild, member: member!, userList };
  }

  private buildRenamedUserList(guild: Guild): GuildMember[] {
    const userList: GuildMember[] = [];
    for (const member of guild.members.cache.values()) {
      if (member.nickname) userList.push(member);
    }
    return userList;
  }

  private async removeNicknames(guild: Guild, currentUser: GuildMember, userList: GuildMember[]): Promise<void> {
    if (userList.length === 0) return;

    this.logInfo(guild, "Begining nickname nuke ...");

    for (const user of userList) {
      this.logInfo(guild, "Renaming %s", user.displayName);

      if (this.hasHighestRolesThanTarget(currentUser, user)) {
        await user.setNickname("").catch(() => {});
        // NOTE(port): faithful to the lua source — `return` here is inside the
        // for-loop/if, so only the FIRST eligible member actually gets renamed
        // even though the calling command's reply claims all of them were reset.
        // This looks like a bug in module_nickname.lua, kept as-is for fidelity.
        return;
      }
    }

    this.logInfo(guild, "Nickname nuke ended !");
  }

  private buildUserListMessage(
    guild: Guild,
    userList: GuildMember[],
    currentPage: number,
  ): { components: ActionRowBuilder<ButtonBuilder>[]; embeds: EmbedBuilder[] } {
    const sorted = [...userList].sort((a, b) => {
      const an = a.user.username;
      const bn = b.user.username;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("row_header_button_0")
          .setLabel("Real Name")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("row_header_button_1")
          .setLabel("Custom Name")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    );

    let i = 0;
    for (const member of sorted) {
      if (i >= this.pageSize * currentPage) {
        if (rows.length > this.pageSize) break;

        const idx = rows.length;
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`row_${idx}_button_0`)
              .setLabel(member.user.username)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`row_${idx}_button_1`)
              .setLabel(member.nickname!)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`${CUSTOM_ID_REMOVE}${member.id}`)
              .setLabel("Remove custom username")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(false),
          ),
        );
      }
      i++;
    }

    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CUSTOM_ID_PAGE}${currentPage - 1}`)
          .setLabel("Prev Page")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(`${CUSTOM_ID_PAGE}${currentPage + 1}`)
          .setLabel("Next Page")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(sorted.length <= this.pageSize * (currentPage + 1)),
      ),
    );

    return {
      components: rows,
      embeds: [new EmbedBuilder().setTitle("Test").setDescription("").setColor(0x00ffff)],
    };
  }
}

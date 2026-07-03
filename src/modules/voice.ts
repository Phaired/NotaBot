// Ported from module_voice.lua — lets a member create a private voice channel by
// joining a configured "trigger" channel. The channel owner (and any authorized
// role) can join freely; everyone else needs to be invited via a user-select
// menu posted in the new channel. The private channel is deleted once the owner
// disconnects from it.
//
// Storage model (persistent, per guild):
//   { PrivateVoiceChannels: { "<ChannelId>": "<OwnerUserId>", ... } }

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { ActionRowBuilder, ChannelType, UserSelectMenuBuilder, type Guild, type VoiceChannel, type VoiceState } from "discord.js";

/** Lua `selectInteractionId = 'private_voice_invite'`. */
const SELECT_INTERACTION_ID = "private_voice_invite";

export default class VoiceModule extends BotModule {
  name = "voice";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "TriggerChannel",
        Description: "The voice channel that members must join in order to create a private voice channel",
        Type: ConfigType.Channel,
        // Lua `Default = false` — no trigger channel configured; kept as
        // Optional (=> undefined) since ConfigType.Channel validation expects
        // a snowflake, not a boolean.
        Optional: true,
      },
      {
        Name: "AuthorizedRoles",
        Description: "Authorized roles to join a private voice channel",
        Type: ConfigType.Role,
        Default: [],
        Array: true,
        Optional: true,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    // Lua `Module:OnInteractionCreate` routed by custom_id. The framework's
    // interaction router does the prefix dispatch for us, but (unlike
    // discordjs-event hooks) it isn't gated by module-enabled state, so we
    // re-check `isEnabledForGuild` here to match the implicit gating the lua
    // module got from bot_modules.lua.
    this.bot.interactions.registerComponent(SELECT_INTERACTION_ID, async (interaction) => {
      if (!interaction.isUserSelectMenu()) return;

      const guild = interaction.guild;
      if (!guild || !this.isEnabledForGuild(guild)) return;

      // cannot rely on interaction.member(s) resolved data because it may be
      // a partial object; look members up on the guild instead.
      const channel = interaction.channel as any;
      if (channel?.permissionOverwrites) {
        for (const userId of interaction.values) {
          const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => undefined));
          if (!member) continue;
          await channel.permissionOverwrites.edit(member, { Connect: true }).catch(() => {});
        }
      }

      await interaction
        .reply({ content: this.bot.format(guild, "VOICE_CONFIRM"), ephemeral: true })
        .catch(() => {});
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;

    if (!config.TriggerChannel) {
      // NOTE(port): lua returned `false, Bot:Format(guild, 'VOICE_MISCONFIG')`
      // but BotModule.onEnable only supports a boolean return in this
      // framework; the caller substitutes a generic "onEnable hook returned
      // false" message instead.
      return false;
    }

    const persistentData = this.getPersistentData(guild)!;
    if (!persistentData.PrivateVoiceChannels) {
      persistentData.PrivateVoiceChannels = {};
      return true;
    }

    // cleanup config and unused channels after reboot
    for (const [channelId, ownerId] of Object.entries(persistentData.PrivateVoiceChannels as Record<string, string>)) {
      const channel = guild.channels.cache.get(channelId);

      if (channel && channel.type === ChannelType.GuildVoice) {
        const isOwnerConnected = (channel as VoiceChannel).members.has(ownerId);

        if (!isOwnerConnected) {
          await channel.delete().catch(() => {});
          delete persistentData.PrivateVoiceChannels[channelId];
          this.logInfo(guild, "Deleted an unused channel %s", channelId);
        }
      } else {
        delete persistentData.PrivateVoiceChannels[channelId];
      }
    }

    await this.savePersistentData(guild);

    return true;
  }

  /** Lua `Module:OnvoiceChannelJoin` / `Module:OnvoiceChannelLeave`, derived from state transitions. */
  async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    if (oldState.channelId === newState.channelId) return;

    if (oldState.channel) await this.handleVoiceLeave(oldState);
    if (newState.channel) await this.handleVoiceJoin(newState);
  }

  private async handleVoiceJoin(state: VoiceState): Promise<void> {
    const channel = state.channel;
    const member = state.member;
    if (!channel || !member) return;

    const guild = channel.guild;
    const config = this.getConfig(guild)!;
    const triggerChannelId = config.TriggerChannel;

    if (!triggerChannelId || channel.id !== triggerChannelId) return;

    const data = this.getPersistentData(guild)!;
    if (!data.PrivateVoiceChannels) data.PrivateVoiceChannels = {};

    const category = channel.parent;
    const privateVoiceName = this.bot.format(guild, "VOICE_CHAN_PREFIX") + member.displayName;

    let privateVoice: VoiceChannel;
    try {
      privateVoice = await guild.channels.create({
        name: privateVoiceName,
        type: ChannelType.GuildVoice,
        parent: category ? category.id : undefined,
      });
    } catch (e: any) {
      this.logError(guild, "Failed to create private voice channel: %s", e?.message ?? e);
      return;
    }

    await privateVoice.permissionOverwrites.edit(guild.roles.everyone, { Connect: false }).catch(() => {});

    await privateVoice.permissionOverwrites
      .edit(member, { Connect: true, MoveMembers: true, SetVoiceChannelStatus: true })
      .catch(() => {});

    for (const roleId of (config.AuthorizedRoles as string[]) ?? []) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;
      await privateVoice.permissionOverwrites
        .edit(role, { Connect: true, MoveMembers: true, SetVoiceChannelStatus: true })
        .catch(() => {});
    }

    await member.voice.setChannel(privateVoice).catch(() => {});

    const rowComponent = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(SELECT_INTERACTION_ID)
        .setPlaceholder(this.bot.format(guild, "VOICE_INTERAC_PLACEHOLDER")),
    );

    await privateVoice
      .send({
        content: this.bot.format(guild, "VOICE_MSG"),
        components: [rowComponent],
      })
      .catch(() => {});

    data.PrivateVoiceChannels[privateVoice.id] = member.id;
    await this.savePersistentData(guild);
  }

  private async handleVoiceLeave(state: VoiceState): Promise<void> {
    const channel = state.channel;
    const member = state.member;
    if (!channel || !member) return;

    const guild = channel.guild;
    const data = this.getPersistentData(guild)!;

    if (!data.PrivateVoiceChannels?.[channel.id]) return;

    if (member.id === data.PrivateVoiceChannels[channel.id]) {
      // will throw an HTTP error if a member with "manage channel" permission
      // deletes the channel while still connected — same caveat as the lua
      // version, hence the .catch below.
      await channel.delete().catch(() => {});
      delete data.PrivateVoiceChannels[channel.id];
      await this.savePersistentData(guild);
    }
  }
}

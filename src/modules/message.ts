// Ported from module_message.lua — lets moderators send/edit raw Discord
// messages (content, embed, buttons/select-menus with "actions"), register
// text-trigger replies (+aliases), dump a message/channel to raw JSON, and
// handles clicks on the buttons/select-menus it created.
//
// This is a faithful, close-to-line-for-line port of a fairly involved bit of
// Lua validation code. A handful of upstream quirks (including a couple of
// what look like genuine bugs) are preserved on purpose — see the
// `// NOTE(port):` comments below and the final report for details.

import {
  ComponentType,
  ButtonStyle,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType, ok, fail } from "../core/configTypes";
import type { CommandContext } from "../core/command";
import type { Bot } from "../core/bot";
import { validateSnowflake } from "../util/snowflake";

// ---------------------------------------------------------------------------
// Generic field validation helpers (ported from the Lua ValidateFields family)
// ---------------------------------------------------------------------------

interface Metadata {
  member?: GuildMember | null;
  guild?: Guild | null;
  /** Present only when buttons/select-menu-options should be turned into real
   * custom_ids (sendmessage/editmessage/addreply/editreply). When absent,
   * `actions` fields are validated but left as-is (matching the Lua source,
   * where triggered Replies never get this and therefore can't actually carry
   * working buttons — see the port report). */
  actions?: Record<string, any[]> | null;
  bot?: Bot;
  customIdCounter?: number;
  discardSelection?: boolean;
}

type FieldValidator = (value: any, metadata: Metadata) => [boolean, string?];

function fromParseResult(pr: [any] | [undefined, string?]): [boolean, string?] {
  return pr[0] !== undefined ? [true] : [false, pr[1]];
}

function validateFields(
  data: any,
  expectedFields: Record<string, FieldValidator>,
  allFieldsExpected = false,
  metadata: Metadata = {},
): [boolean, string?] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [false, " must be an object"];
  }

  let count = 0;
  for (const fieldName of Object.keys(data)) {
    const fieldValidator = expectedFields[fieldName];
    if (!fieldValidator) return [false, `.${fieldName} is not an expected field`];

    const [success, err] = fieldValidator(data[fieldName], metadata);
    if (!success) return [false, `.${fieldName}${err ?? ""}`];

    count++;
  }

  if (allFieldsExpected && count !== Object.keys(expectedFields).length) {
    for (const fieldName of Object.keys(expectedFields)) {
      if (data[fieldName] === undefined) return [false, `.${fieldName} has no value`];
    }
  }

  if (count === 0) return [false, " must contain something"];

  return [true];
}

// NOTE(port): the Lua `ValidateBoolean` returns a bare boolean (no error
// text); concatenating that `nil` error onto a string would actually crash
// the original script. We give a sane error message instead.
function validateBoolean(value: any): [boolean, string?] {
  return typeof value === "boolean" ? [true] : [false, " must be a boolean"];
}

function validateInteger(value: any): [boolean, string?] {
  if (typeof value !== "number" || !Number.isInteger(value)) return [false, " must be an integer"];
  return [true];
}

function validateString(value: any): [boolean, string?] {
  if (typeof value !== "string") return [false, " must be a string"];
  if (value.length === 0) return [false, " cannot be empty"];
  return [true];
}

// --- embed field validation --------------------------------------------------

const footerFields: Record<string, FieldValidator> = {
  icon_url: (v) => validateString(v),
  text: (v) => validateString(v),
};
const imageFields: Record<string, FieldValidator> = { url: (v) => validateString(v) };
const thumbnailFields: Record<string, FieldValidator> = { url: (v) => validateString(v) };
const authorFields: Record<string, FieldValidator> = {
  name: (v) => validateString(v),
  url: (v) => validateString(v),
  icon_url: (v) => validateString(v),
};
const fieldFields: Record<string, FieldValidator> = {
  name: (v) => validateString(v),
  value: (v) => validateString(v),
  inline: (v) => validateBoolean(v),
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):?([\d.]*)([Z+-]?)(\d?\d?):?(\d?\d?)$/;

const embedFields: Record<string, FieldValidator> = {
  title: (v) => validateString(v),
  description: (v) => validateString(v),
  url: (v) => validateString(v),
  color: (v) => {
    if (typeof v !== "number" || !Number.isInteger(v)) return [false, " must be an integer"];
    if (v < 0 || v > 16777215) return [false, " must be an integer in [0, 16777215] range"];
    return [true];
  },
  timestamp: (v) => {
    const [success, err] = validateString(v);
    if (!success) return [false, err];
    if (!DATE_RE.test(v)) return [false, " is not a valid date"];
    return [true];
  },
  footer: (v) => validateFields(v, footerFields),
  thumbnail: (v) => validateFields(v, thumbnailFields, true),
  image: (v) => validateFields(v, imageFields, true),
  author: (v) => {
    const [success, err] = validateFields(v, authorFields);
    if (!success) return [false, err];
    if (!v.name) return [false, " must have a name field"];
    return [true];
  },
  fields: (v) => {
    if (!Array.isArray(v)) return [false, " must be an object"];
    for (let idx = 0; idx < v.length; idx++) {
      const [success, err] = validateFields(v[idx], fieldFields);
      if (!success) return [false, `[${idx + 1}]${err}`];
      if (v[idx].name === undefined) return [false, `[${idx + 1}].name must contain something`];
      if (v[idx].value === undefined) return [false, `[${idx + 1}].value must contain something`];
    }
    return [true];
  },
};

// --- action ("what happens when a button/select option is used") -----------

function validateRole(value: any, metadata: Metadata): [boolean, string?] {
  const [success, err] = fromParseResult(validateSnowflake(value));
  if (!success) return [false, err];

  if (metadata.guild) {
    const targetRole = metadata.guild.roles.cache.get(value);
    if (!targetRole) return [false, ": invalid role"];

    if (metadata.member) {
      if (!metadata.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return [false, ": you need to have the manage roles permission to toggle a role"];
      }
      if (targetRole.position > metadata.member.roles.highest.position) {
        return [false, ": you cannot add or remove a role higher than your own"];
      }
    }
  }

  return [true];
}

const actionValidators: Record<string, (value: any, metadata: Metadata) => [boolean, string?]> = {
  reply: (value) => {
    const [success, err] = validateString(value);
    if (!success) return [false, err];
    if (value.length > 100) return [false, " is too long (must be <=100 characters)"];
    return [true];
  },
  addrole: (value, metadata) => validateRole(value, metadata),
  removerole: (value, metadata) => validateRole(value, metadata),
  togglerole: (value, metadata) => validateRole(value, metadata),
  openticket: (value, metadata) => {
    const modmail = metadata.bot?.getModuleForGuild(metadata.guild ?? null, "modmail");
    if (!modmail) return [false, "modmail module is disabled"];

    if (value === undefined || value === null || value === "") return [true];

    const [success, err] = validateString(value);
    if (!success) return [false, err];
    if (value.length > 100) return [false, " is too long (must be <=100 characters)"];
    return [true];
  },
};

function validateActions(actions: any, metadata: Metadata): [boolean, string?] {
  if (!Array.isArray(actions) || actions.length === 0) return [false, " must be an array"];
  if (actions.length > 20) return [false, " has too many values (a maximum of 20 actions are supported)"];

  // NOTE(port): faithfully reproduces a bug in the original Lua — the `return`
  // inside this loop is unconditional, so only actions[0] is ever type/value
  // checked; any further actions in the array are accepted unchecked (they
  // still count towards the 20-item cap above though).
  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx];
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      return [false, `[${idx + 1}] must be an object`];
    }

    const [okType, errType] = validateString(action.type);
    if (!okType) return [false, `[${idx + 1}].type${errType}`];

    const validator = actionValidators[action.type];
    if (!validator) return [false, `[${idx + 1}].type is not valid`];

    return validator(action.value, metadata);
  }

  return [true];
}

function generateCustomId(actions: any[], metadata: Metadata): string {
  const customId = `action_${metadata.customIdCounter ?? 1}`;
  metadata.customIdCounter = (metadata.customIdCounter ?? 1) + 1;
  metadata.actions![customId] = actions;
  return customId;
}

// --- message components (action row / button / select menu) ----------------

const emojiFields: Record<string, FieldValidator> = {
  id: (v) => fromParseResult(validateSnowflake(v)),
  name: (v) => validateString(v),
};

const buttonFields: Record<string, FieldValidator> = {
  type: (v) => (v === ComponentType.Button ? [true] : [false, " must be button"]),
  // NOTE(port): the Lua source hardcodes a leading ".style" inside this
  // message *and* it's returned through the generic field wrapper (which
  // already prefixes ".style"), so an out-of-range style produces a doubled
  // ".style.style must be a valid button style" error. Preserved as-is.
  style: (v) => {
    const [success, err] = validateInteger(v);
    if (!success) return [false, err];
    if (v < 1 || v > 5) return [false, ".style must be a valid button style"];
    return [true];
  },
  label: (v) => validateString(v),
  url: (v) => validateString(v),
  disabled: (v) => validateBoolean(v),
  emoji: (v) => validateFields(v, emojiFields),
  actions: (v, metadata) => validateActions(v, metadata),
};

function validateButtonComponent(button: any, metadata: Metadata): [boolean, string?] {
  if (button.type === undefined) return [false, ".type must exist"];
  if (button.style === undefined) return [false, ".style must exist"];

  const [success, err] = validateFields(button, buttonFields, false, metadata);
  if (!success) return [false, err];

  if (button.style === ButtonStyle.Link) {
    if (button.url === undefined) return [false, " must have an url (because its style is link)"];
    if (button.actions !== undefined) return [false, " cannot have an actions field (because its style is link)"];
  } else {
    if (button.actions === undefined) return [false, " must have an actions field (because its style is not link)"];
    if (button.url !== undefined) return [false, " cannot have an url (because its style is not link)"];
  }

  if (metadata.actions && button.actions) {
    button.custom_id = generateCustomId(button.actions, metadata);
    delete button.actions;
  }

  return [true];
}

const selectMenuOptionFields: Record<string, FieldValidator> = {
  label: (v) => validateString(v),
  description: (v) => validateString(v),
  emoji: (v) => validateFields(v, emojiFields),
  default: (v) => validateBoolean(v),
  actions: (v, metadata) => validateActions(v, metadata),
};

const selectMenuFields: Record<string, FieldValidator> = {
  type: (v) => validateInteger(v),
  options: (options: any, metadata: Metadata) => {
    if (!Array.isArray(options) || options.length === 0) return [false, " must be an array"];

    for (let idx = 0; idx < options.length; idx++) {
      const option = options[idx];
      const [success, err] = validateFields(option, selectMenuOptionFields, false, metadata);
      if (!success) return [false, `[${idx + 1}]${err}`];

      if (option.label === undefined) return [false, `[${idx + 1}].label must be valid`];
      if (option.actions === undefined) return [false, `[${idx + 1}].actions must be valid`];

      if (metadata.actions) {
        if (metadata.discardSelection) {
          option.actions.push({ type: "refreshmenu" });
        }
        option.value = generateCustomId(option.actions, metadata);
        delete option.actions;
      }
    }

    return [true];
  },
  placeholder: (v) => validateString(v),
  min_values: (v) => {
    const [success, err] = validateInteger(v);
    if (!success) return [false, err];
    if (v < 0 || v > 25) return [false, " must be between 0 and 25"];
    return [true];
  },
  max_values: (v) => {
    const [success, err] = validateInteger(v);
    if (!success) return [false, err];
    if (v < 1 || v > 25) return [false, " must be between 1 and 25"];
    return [true];
  },
  disabled: (v) => validateBoolean(v),
  discard_selection: (v) => validateBoolean(v),
};

function validateSelectMenuComponent(selectmenu: any, metadata: Metadata): [boolean, string?] {
  if (selectmenu.type === undefined) return [false, ".type must exist"];
  if (selectmenu.options === undefined) return [false, ".options must exist"];

  metadata.discardSelection = !!selectmenu.discard_selection;

  const [success, err] = validateFields(selectmenu, selectMenuFields, false, metadata);
  if (!success) return [false, err];

  metadata.discardSelection = undefined;

  selectmenu.custom_id = `message_placeholder${metadata.customIdCounter ?? 1}`;
  metadata.customIdCounter = (metadata.customIdCounter ?? 1) + 1;

  return [true];
}

function validateActionRowComponent(component: any, metadata: Metadata): [boolean, string?] {
  if (typeof component !== "object" || component === null || component.type !== ComponentType.ActionRow) {
    return [false, ".type must be action row"];
  }
  if (!Array.isArray(component.components) || component.components.length === 0) {
    return [false, ".components must be an array"];
  }

  for (let idx = 0; idx < component.components.length; idx++) {
    const [success, err] = validateComponent(component.components[idx], metadata);
    if (!success) return [false, `.components[${idx + 1}]${err}`];
  }

  return [true];
}

function validateComponent(component: any, metadata: Metadata): [boolean, string?] {
  if (typeof component !== "object" || component === null || typeof component.type !== "number" || !Number.isInteger(component.type)) {
    return [false, ".type must be an integer"];
  }

  if (component.type === ComponentType.ActionRow) {
    return [false, "an action row cannot contain action rows"];
  } else if (component.type === ComponentType.Button) {
    return validateButtonComponent(component, metadata);
  } else if (component.type === ComponentType.StringSelect) {
    return validateSelectMenuComponent(component, metadata);
  } else {
    return [false, ".type is not valid"];
  }
}

// --- top-level message data --------------------------------------------------

const messageFields: Record<string, FieldValidator> = {
  components: (components: any, metadata: Metadata) => {
    if (!Array.isArray(components) || components.length === 0) return [false, "Components must be an array"];
    if (components.length > 5) return [false, "Too many components (each message can only have up to 5 components)"];

    metadata.customIdCounter = 1;

    for (let idx = 0; idx < components.length; idx++) {
      const [success, err] = validateActionRowComponent(components[idx], metadata);
      if (!success) return [false, `[${idx + 1}]${err}`];
    }

    return [true];
  },
  content: (v) => validateString(v),
  embed: (v) => validateFields(v, embedFields),
  tts: (v) => validateBoolean(v),
  deleteInvokation: (v) => validateBoolean(v),
};

function validateMessageData(
  data: any,
  member: GuildMember | null | undefined,
  guild: Guild | null | undefined,
  actions: Record<string, any[]> | undefined,
  bot: Bot | undefined,
): [boolean, string?] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [false, "MessageData must be an object"];
  }

  const metadata: Metadata = { member, guild, actions, bot };
  const [success, err] = validateFields(data, messageFields, false, metadata);
  if (!success) return [false, `MessageData${err}`];

  if (!data.content && !data.embed) {
    return [false, "MessageData must have at least a content or embed field"];
  }

  return [true];
}

function trimPrependedMention(str: string): string {
  const m = str.match(/^(<@!?\d+>)/);
  return m ? str.slice(m[1].length) : str;
}

// ---------------------------------------------------------------------------

export default class MessageModule extends BotModule {
  name = "message";

  checkPermissions(member: GuildMember | null): boolean {
    if (!member) return false;
    const config = this.getConfig(member.guild);
    const authorizedRoles: string[] = config?.AuthorizedRoles ?? [];
    for (const roleId of authorizedRoles) {
      if (member.roles.cache.has(roleId)) return true;
    }
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "AuthorizedRoles",
        Description: "Roles which can use the commands",
        Type: ConfigType.Role,
        Default: [],
        Array: true,
      },
      {
        Name: "Replies",
        Description: "Map associating a trigger with a reply",
        Type: ConfigType.Custom,
        Default: {},
        ValidateConfig: (value: any, _def: ConfigDefinition, guildId?: string) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return fail("Replies must be an object");
          }
          const guild = guildId ? this.bot.client.guilds.cache.get(guildId) : undefined;
          for (const [trigger, reply] of Object.entries(value)) {
            const [okTrigger, errTrigger] = validateString(trigger);
            if (!okTrigger) return fail(`Replies keys error (${trigger} ${errTrigger})`);

            const [okReply, errReply] = validateMessageData(reply, undefined, guild, undefined, this.bot);
            if (!okReply) return fail(`Replies[${trigger}]${errReply}`);
          }
          return ok(true);
        },
      },
      {
        Name: "Aliases",
        Description: "Map associating a trigger with a reply",
        Type: ConfigType.Custom,
        Default: {},
        ValidateConfig: (value: any) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return fail("Aliases must be an object");
          }
          for (const [alias, reply] of Object.entries(value)) {
            const [okAlias, errAlias] = validateString(alias);
            if (!okAlias) return fail(`Aliases keys error (${alias} ${errAlias})`);

            const [okReply, errReply] = validateString(reply);
            if (!okReply) return fail(`Aliases[${alias}]${errReply}`);
          }
          return ok(true);
        },
      },
      {
        Name: "DeleteInvokation",
        Description: "Deletes the message that invoked the reply",
        Type: ConfigType.Boolean,
        Default: false,
      },
      {
        Name: "MaxActionMessage",
        Description: "How many actions messages are allowed per server",
        Type: ConfigType.Integer,
        Default: 20,
      },
    ];
  }

  // --- helpers (ported from the Lua Module methods) -------------------------

  private replaceData(data: any, triggeringMember: GuildMember): any {
    if (data === null || data === undefined) return data;

    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) data[i] = this.replaceData(data[i], triggeringMember);
      return data;
    }

    if (typeof data === "object") {
      for (const k of Object.keys(data)) data[k] = this.replaceData(data[k], triggeringMember);
      return data;
    }

    if (typeof data === "string") {
      return data
        .split("{user}").join(triggeringMember.toString())
        .split("{userTag}").join(triggeringMember.user.tag)
        .split("{userMention}").join(triggeringMember.toString());
    }

    return data;
  }

  private async registerAction(
    guild: Guild,
    messageId: string,
    actions: Record<string, any[]>,
  ): Promise<[true] | [false, string]> {
    if (Object.keys(actions).length === 0) return [true];

    const config = this.getConfig(guild)!;
    const persistentData = this.getPersistentData(guild)!;
    persistentData.MessageActions = persistentData.MessageActions || {};

    if (!persistentData.MessageActions[messageId]) {
      const count = Object.keys(persistentData.MessageActions).length;
      if (count >= config.MaxActionMessage) {
        return [false, `too many messages with actions (${count} >= ${config.MaxActionMessage})`];
      }
    }

    persistentData.MessageActions[messageId] = actions;
    return [true];
  }

  private buildSendPayload(data: any): any {
    const payload: any = {};
    if (data.content !== undefined) payload.content = data.content;
    if (data.embed !== undefined) payload.embeds = [data.embed];
    if (data.tts !== undefined) payload.tts = data.tts;
    if (data.components !== undefined) payload.components = data.components;
    return payload;
  }

  private getMessageFields(message: Message): any {
    const rawEmbed = (message.embeds[0] as any)?.toJSON?.() ?? message.embeds[0] ?? undefined;
    if (rawEmbed) {
      delete rawEmbed.type;
      if (rawEmbed.author) delete rawEmbed.author.proxy_icon_url;
    }

    return {
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        filename: a.name,
        size: a.size,
        url: a.url,
        proxy_url: a.proxyURL,
        content_type: a.contentType ?? undefined,
        width: a.width ?? undefined,
        height: a.height ?? undefined,
      })),
      content: message.content.length > 0 ? message.content : undefined,
      embed: rawEmbed,
      tts: message.tts || undefined,
      interaction: (message as any).interaction ?? undefined,
      components: message.components?.map((c: any) => (c.toJSON ? c.toJSON() : c)),
      sticker_items: [...message.stickers.values()].map((s) => ({ id: s.id, name: s.name, format_type: s.format })),
    };
  }

  private async parseContentParameter(
    content: string | undefined,
    ctx: CommandContext,
    actions: Record<string, any[]> | undefined,
  ): Promise<any | undefined> {
    if (content) {
      const codeBlockMatch = content.match(/^```(\w*)\n([\s\S]+)```$/);
      if (codeBlockMatch) {
        const language = codeBlockMatch[1];
        const code = codeBlockMatch[2];

        if (language.length > 0 && language !== "json") {
          await ctx.reply(`Expected a json message, got ${language}`);
          return undefined;
        }

        let messageData: any;
        try {
          messageData = JSON.parse(code);
        } catch (e: any) {
          await ctx.reply(`Expected a valid json code, parsing failed: ${e?.message ?? e}`);
          return undefined;
        }

        const [success, err] = validateMessageData(messageData, ctx.member, ctx.guild, actions, this.bot);
        if (!success) {
          await ctx.reply(err!);
          return undefined;
        }

        return messageData;
      } else {
        const [message] = await this.bot.decodeMessage(content, false, true);
        if (
          message &&
          message.member &&
          message.member.permissionsIn(message.channel as any).has(PermissionFlagsBits.ViewChannel)
        ) {
          return this.getMessageFields(message);
        }
        return { content };
      }
    } else if (ctx.attachments && ctx.attachments.length > 0) {
      if (ctx.attachments.length !== 1) {
        await ctx.reply("You can send only one file!");
        return undefined;
      }

      const attachment = ctx.attachments[0];
      const filename: string = attachment.name ?? "";
      if (!/\.json$/i.test(filename)) {
        await ctx.reply("You must send a .json file");
        return undefined;
      }

      if (attachment.size >= 1024 * 1024) {
        await ctx.reply("This file is too big!");
        return undefined;
      }

      let res: Response;
      try {
        res = await fetch(attachment.url);
      } catch (e: any) {
        await ctx.reply(`Failed to download file: ${e?.message ?? e}`);
        return undefined;
      }

      if (res.status !== 200) {
        await ctx.reply(`Failed to download file (${res.status}): `);
        return undefined;
      }

      const body = await res.text();
      let messageData: any;
      try {
        messageData = JSON.parse(body);
      } catch (e: any) {
        await ctx.reply(`Expected a valid json code, parsing failed: ${e?.message ?? e}`);
        return undefined;
      }

      const [success, err] = validateMessageData(messageData, ctx.member, ctx.guild, actions, this.bot);
      if (!success) {
        await ctx.reply(err!);
        return undefined;
      }

      return messageData;
    } else {
      await ctx.reply("Expected some content or a file, got nothing");
      return undefined;
    }
  }

  private async executeAction(type: string, value: any, member: GuildMember): Promise<string | undefined> {
    const guild = member.guild;

    switch (type) {
      case "reply":
        return this.replaceData(value, member);

      case "addrole": {
        const role = guild.roles.cache.get(value);
        if (member.roles.cache.has(value)) return undefined;
        try {
          await member.roles.add(value);
          return `✅ Role ${role ? role.toString() : value} added`;
        } catch {
          return `⚠️ Failed to remove ${role ? role.toString() : value}`;
        }
      }

      case "removerole": {
        const role = guild.roles.cache.get(value);
        if (!member.roles.cache.has(value)) return undefined;
        try {
          await member.roles.remove(value);
          return `✅ Role ${role ? role.toString() : value} removed`;
        } catch {
          return `⚠️ Failed to remove ${role ? role.toString() : value}`;
        }
      }

      case "togglerole": {
        const role = guild.roles.cache.get(value);
        if (member.roles.cache.has(value)) {
          try {
            await member.roles.remove(value);
            return `❎ Role ${role ? role.toString() : value} removed`;
          } catch {
            return `⚠️ Failed to remove ${role ? role.toString() : value}`;
          }
        } else {
          try {
            await member.roles.add(value);
            return `✅ Role ${role ? role.toString() : value} added`;
          } catch {
            return `⚠️ Failed to remove ${role ? role.toString() : value}`;
          }
        }
      }

      case "openticket": {
        // TODO(port): reaches into modmail's `openTicket` (a private method)
        // via an `any` cast since modules can't expose new public API here.
        const modmail: any = this.bot.getModuleForGuild(guild, "modmail");
        if (!modmail) return "❌ modmail is currently disabled";
        try {
          const [ticketChannel, err] = await modmail.openTicket(member, member, value || undefined, true);
          if (!ticketChannel) return `❌ failed to open modmail ticket: ${err}`;
          return `✅ a modmail ticket has been created: ${ticketChannel.toString()}`;
        } catch (e: any) {
          return `❌ failed to open modmail ticket: ${e?.message ?? e}`;
        }
      }

      default:
        return undefined;
    }
  }

  /**
   * Local stand-in for the lua `Bot:FetchChannelMessages` helper (its exact
   * pagination semantics aren't visible from module_message.lua and it isn't
   * ported to core yet). Paginates via the REST API in either direction.
   */
  private async fetchChannelMessages(
    channel: any,
    afterId: string | undefined,
    limit: number,
    newestFirst: boolean,
  ): Promise<[Message[]] | [undefined, string]> {
    try {
      const collected: Message[] = [];
      let beforeCursor: string | undefined;
      let afterCursor: string | undefined = afterId;

      while (collected.length < limit) {
        const batchSize = Math.min(100, limit - collected.length);
        const options: any = { limit: batchSize };
        if (newestFirst) {
          if (beforeCursor) options.before = beforeCursor;
        } else {
          if (afterCursor) options.after = afterCursor;
        }

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        const sorted = [...batch.values()].sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp);
        collected.push(...sorted);

        if (newestFirst) beforeCursor = sorted[0].id;
        else afterCursor = sorted[sorted.length - 1].id;

        if (batch.size < batchSize) break;
      }

      if (newestFirst) collected.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      return [collected.slice(0, limit)];
    } catch (e: any) {
      return [undefined, e?.message ?? String(e)];
    }
  }

  /** Local stand-in for the lua `bot:MessagesToTable` helper. */
  private messagesToTable(messages: Message[]): any {
    return { messages: messages.map((m) => this.getMessageFields(m)) };
  }

  // --- lifecycle --------------------------------------------------------------

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "rawmessage",
      Args: [{ Name: "message", Type: ConfigType.Message, Description: "Message link" }],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Prints a message in a raw form",
      Func: async (ctx: CommandContext, message: Message) => {
        const fields = this.getMessageFields(message);
        const fieldJson = JSON.stringify(fields, null, 1);
        const link = this.bot.generateMessageLink(message);

        try {
          if (fieldJson.length > 1800) {
            await ctx.reply({
              embed: {
                title: `Raw form of message ${link}`,
                description: "Message json was too big and has been sent as a file",
              },
            });
            await ctx.reply({ file: ["message.json", fieldJson] });
          } else {
            await ctx.reply({
              embed: {
                title: `Raw form of message ${link}`,
                description: `\`\`\`json\n${fieldJson}\`\`\``,
              },
            });
          }
        } catch (e: any) {
          await ctx.reply(`Discord rejected the message: ${e?.message ?? e}`).catch(() => {});
        }
      },
    });

    this.registerCommand({
      Name: "sendmessage",
      Args: [
        { Name: "channel", Type: ConfigType.Channel, Optional: true, Description: "Target channel" },
        { Name: "content", Type: ConfigType.String, Optional: true, Description: "Message content or JSON" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Makes the bot send a message",
      Func: async (ctx: CommandContext, channel: any, content?: string) => {
        const actions: Record<string, any[]> = {};
        const messageData = await this.parseContentParameter(content, ctx, actions);
        if (!messageData) return;

        const member = ctx.member!;
        const targetChannel = channel ?? ctx.channel;
        if (!targetChannel) return;

        const perms = member.permissionsIn(targetChannel);
        if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
          await ctx.reply("You don't have the permission to send messages in that channel");
          return;
        }

        try {
          const sent = await targetChannel.send(this.buildSendPayload(messageData));
          const [success, err] = await this.registerAction(ctx.guild!, sent.id, actions);
          if (!success) await ctx.reply(`Message sent but actions couldn't be registered: ${err}`);
        } catch (e: any) {
          await ctx.reply(`Discord rejected the message: ${e?.message ?? e}`);
        }
      },
    });

    this.registerCommand({
      Name: "editmessage",
      Args: [
        { Name: "message", Type: ConfigType.Message, Description: "Message link" },
        { Name: "content", Type: ConfigType.String, Optional: true, Description: "New content or JSON" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Edit one of the message posted by the bot",
      Func: async (ctx: CommandContext, message: Message, content?: string) => {
        const actions: Record<string, any[]> = {};
        const messageData = await this.parseContentParameter(content, ctx, actions);
        if (!messageData) return;

        if (message.author.id !== this.bot.client.user?.id) {
          await ctx.reply("You can only ask me to edit my own messages");
          return;
        }

        const member = ctx.member!;
        const perms = member.permissionsIn(message.channel as any);
        if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
          await ctx.reply("You don't have the permission to send messages in that channel");
          return;
        }

        try {
          await message.edit(this.buildSendPayload(messageData));
          const [success, err] = await this.registerAction(ctx.guild!, message.id, actions);
          if (!success) await ctx.reply(`Message sent but actions couldn't be registered: ${err}`);
        } catch (e: any) {
          await ctx.reply(`Discord rejected the message: ${e?.message ?? e}`);
        }
      },
    });

    this.registerCommand({
      Name: "addreply",
      Args: [
        { Name: "trigger", Type: ConfigType.String, Description: "The text that triggers the reply" },
        { Name: "content", Type: ConfigType.String, Optional: true, Description: "Reply content or JSON" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Registers a reply to a particular message",
      Func: async (ctx: CommandContext, trigger: string, content?: string) => {
        const messageData = await this.parseContentParameter(content, ctx, undefined);
        if (!messageData) return;

        const config = this.getConfig(ctx.guild!)!;
        config.Replies = config.Replies || {};
        config.Replies[trigger] = messageData;

        await this.saveGuildConfig(ctx.guild!);

        await ctx.reply(`Registered a reply for "${trigger}"`);
      },
    });

    this.registerCommand({
      Name: "removereply",
      Args: [{ Name: "trigger", Type: ConfigType.String, Description: "The trigger to remove" }],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Unregisters a reply to a particular message",
      Func: async (ctx: CommandContext, trigger: string) => {
        const config = this.getConfig(ctx.guild!)!;
        config.Replies = config.Replies || {};
        if (!config.Replies[trigger]) {
          await ctx.reply(`No reply is registered for ${trigger}`);
          return;
        }
        delete config.Replies[trigger];

        await this.saveGuildConfig(ctx.guild!);

        await ctx.reply(`${trigger} will no longer trigger a reply`);
      },
    });

    this.registerCommand({
      Name: "listreplies",
      Args: [],
      Help: "List all replies and their aliases",
      Func: async (ctx: CommandContext) => {
        const config = this.getConfig(ctx.guild!)!;
        const replies: Record<string, any> = config.Replies || {};
        const aliases: Record<string, string> = config.Aliases || {};

        let result = "```replies                         aliases\n\n";
        for (const kr of Object.keys(replies)) {
          let alias = "";
          for (const [ka, kv] of Object.entries(aliases)) {
            if (kr === kv) alias = ka;
          }
          result += `${kr.padEnd(28)}    ${alias}\n`;
        }
        result += "```";

        await ctx.reply(result);
      },
    });

    this.registerCommand({
      Name: "addalias",
      Args: [
        { Name: "alias", Type: ConfigType.String, Description: "Alias name" },
        { Name: "trigger", Type: ConfigType.String, Description: "Reply trigger it aliases" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Registers an alias for a reply",
      Func: async (ctx: CommandContext, alias: string, trigger: string) => {
        const config = this.getConfig(ctx.guild!)!;
        config.Replies = config.Replies || {};

        if (config.Replies[alias]) {
          await ctx.reply(`A reply is already registered for \`${alias}\`, thus, cannot be an alias of itself.`);
          return;
        }

        config.Aliases = config.Aliases || {};
        config.Aliases[alias] = trigger;

        await this.saveGuildConfig(ctx.guild!);

        await ctx.reply(`Registered \`${alias}\` as an alias for "${trigger}"`);
      },
    });

    this.registerCommand({
      Name: "removealias",
      Args: [{ Name: "alias", Type: ConfigType.String, Description: "Alias to remove" }],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Unregisters an alias for a reply",
      Func: async (ctx: CommandContext, alias: string) => {
        const config = this.getConfig(ctx.guild!)!;
        config.Aliases = config.Aliases || {};
        if (!config.Aliases[alias]) {
          await ctx.reply(`No alias is registered for ${alias}`);
          return;
        }
        const trigger = config.Aliases[alias];
        delete config.Aliases[alias];

        await this.saveGuildConfig(ctx.guild!);

        await ctx.reply(`Removed alias (\`${alias}\`) for "${trigger}"`);
      },
    });

    this.registerCommand({
      Name: "editreply",
      Args: [
        { Name: "trigger", Type: ConfigType.String, Description: "Reply to edit" },
        { Name: "content", Type: ConfigType.String, Optional: true, Description: "New content or JSON" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Edits a reply",
      Func: async (ctx: CommandContext, trigger: string, content?: string) => {
        const messageData = await this.parseContentParameter(content, ctx, undefined);
        if (!messageData) return;

        const config = this.getConfig(ctx.guild!)!;
        config.Replies = config.Replies || {};
        if (!config.Replies[trigger]) {
          await ctx.reply(`No reply is registered for ${trigger}`);
          return;
        }
        config.Replies[trigger] = messageData;

        await this.saveGuildConfig(ctx.guild!);

        await ctx.reply(`Edited the reply for "${trigger}"`);
      },
    });

    this.registerCommand({
      Name: "savechannelmessages",
      Args: [
        { Name: "channel", Type: ConfigType.Channel, Optional: true, Description: "Target channel" },
        { Name: "afterMessage", Type: ConfigType.Message, Optional: true, Description: "Fetch messages after this one" },
        { Name: "limit", Type: ConfigType.Integer, Optional: true, Description: "Max number of messages (default 1000)" },
        { Name: "fromFirstMessage", Type: ConfigType.Boolean, Optional: true, Description: "Fetch oldest-first" },
      ],
      PrivilegeCheck: (member) => this.checkPermissions(member),
      Help: "Saves all messages posted in a channel in a json format",
      Func: async (
        ctx: CommandContext,
        channelArg: any,
        afterMessage: Message | undefined,
        limit: number | undefined,
        fromFirstMessage: boolean | undefined,
      ) => {
        const lim = limit ?? 1000;
        if (ctx.author.id !== this.bot.config.ownerUserId) {
          // Don't allow everyone to bypass the limit and get all messages
          // (would require a lot of API calls).
          if (lim > 1000) {
            await ctx.reply(
              "Only bot owner can ask to retrieve more than 1000+ messages at once, due to the number of API calls required to fetch messages",
            );
            return;
          }
        }

        let targetChannel: any = channelArg;
        if (afterMessage) {
          if (targetChannel) {
            if (targetChannel.id !== afterMessage.channel.id) {
              await ctx.reply("Target message doesn't belong to that channel");
              return;
            }
          } else {
            targetChannel = afterMessage.channel;
          }
        }
        if (!targetChannel) targetChannel = ctx.channel;

        await targetChannel.sendTyping?.().catch(() => {});

        const [messages, err] = await this.fetchChannelMessages(targetChannel, afterMessage?.id, lim, !fromFirstMessage);
        if (!messages) {
          await ctx.reply(`An error occurred: ${err}`);
          return;
        }

        const messageData: any = this.messagesToTable(messages);
        messageData.requestedBy = ctx.author.id;

        const jsonSave = JSON.stringify(messageData, null, 1);
        await ctx.reply({
          content: `${messages.length} message(s) of channel ${targetChannel.toString()} have been saved to following file`,
          file: ["messages.json", jsonSave],
        });
      },
    });

    return true;
  }

  // --- discord.js event hooks --------------------------------------------------

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) return;
    if (message.author.bot) return;
    if (!message.content || message.attachments.size > 0) return;

    const guild = message.guild;
    if (!guild) return;

    const config = this.getConfig(guild);
    if (!config) return;

    const content = trimPrependedMention(message.content).trim();
    const replies: Record<string, any> = config.Replies || {};
    const aliases: Record<string, string> = config.Aliases || {};
    const reply = replies[content] ?? replies[aliases[content]];
    if (!reply) return;

    const replyData = JSON.parse(JSON.stringify(reply));

    // NOTE(port): matches the lua source exactly — `actions` is not passed
    // here, so buttons/select-menus on a triggered Reply never get their
    // custom_id generated/registered (they were only ever meant to work when
    // freshly sent via `sendmessage`/`editmessage`).
    const [success, err] = validateMessageData(replyData, message.member, guild, undefined, this.bot);
    if (!success) {
      await message.reply(err!).catch(() => {});
      return;
    }

    if (message.member) {
      replyData.content = this.replaceData(replyData.content, message.member);
      replyData.embed = this.replaceData(replyData.embed, message.member);
    }

    const deleteInvokation = "deleteInvokation" in replyData ? replyData.deleteInvokation : undefined;
    delete replyData.deleteInvokation;
    const shouldDelete = deleteInvokation !== undefined ? deleteInvokation : config.DeleteInvokation;

    let referenceId = message.id;
    if (!shouldDelete) {
      const mentionedUser = message.mentions.users.first();
      const lastMessage = mentionedUser
        ? message.channel.messages.cache.find((m) => m.author.id === mentionedUser.id)
        : undefined;
      referenceId = lastMessage?.id ?? message.reference?.messageId ?? message.id;
    }

    const payload = this.buildSendPayload(replyData);
    payload.reply = { messageReference: referenceId, failIfNotExists: false };

    try {
      await (message.channel as any).send(payload);
      if (shouldDelete) await message.delete().catch(() => {});
    } catch (e: any) {
      this.logError(guild, "Failed to reply to %s: %s", message.content, e?.message ?? String(e));
    }
  }

  // discord.js merges discordia's `OnMessageDelete`/`OnMessageDeleteUncached`
  // into a single `messageDelete` event (the message may be partial, but
  // `.id`/`.guildId` are always present, which is all we need here).
  async onMessageDelete(message: Message): Promise<void> {
    const guild = message.guild ?? (message.guildId ? this.bot.client.guilds.cache.get(message.guildId) : undefined);
    if (!guild) return;

    const persistentData = this.getPersistentData(guild);
    if (persistentData?.MessageActions) {
      delete persistentData.MessageActions[message.id];
    }
  }

  async onInteractionCreate(interaction: any): Promise<void> {
    const guild: Guild | null = interaction.guild;
    if (!guild) return;
    if (!interaction.isButton?.() && !interaction.isStringSelectMenu?.()) return;

    const persistentData = this.getPersistentData(guild);
    const messageActions: Record<string, any[]> | undefined = persistentData?.MessageActions?.[interaction.message.id];
    if (!messageActions) return;

    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    let shouldRefresh = false;
    const messages: string[] = [];
    const member = interaction.member as GuildMember;

    const handleActions = async (id: string) => {
      const actions = messageActions[id];
      if (!actions) return;

      for (const action of actions) {
        if (action.type === "refreshmenu") {
          shouldRefresh = true;
        } else if (!(action.type in actionValidators)) {
          messages.push(`<invalid action ${action.type}>`);
          return;
        } else {
          const response = await this.executeAction(action.type, action.value, member);
          if (response && response.length > 0) messages.push(response);
        }
      }
    };

    if (interaction.isButton()) {
      await handleActions(interaction.customId);
    } else {
      for (const value of interaction.values) {
        await handleActions(value);
      }
    }

    await interaction
      .editReply({ content: messages.length > 0 ? messages.join("\n") : "Nothing to do" })
      .catch(() => {});

    // C'est saaaaaaaaaaaaale
    if (shouldRefresh) {
      await interaction.message.edit({ components: interaction.message.components }).catch(() => {});
    }
  }
}

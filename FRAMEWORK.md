# NotaBot-TS framework & porting guide

This is the framework/API reference and the contract that was used to port each
`module_<name>.lua` into `src/modules/<name>.ts`. The original Lua sources are no longer
in this branch (see git history); use this as the guide for writing new modules.

**Worked examples to copy from:** `src/modules/game.ts`, `src/modules/roleinfo.ts`,
`src/modules/_template.ts`. The source of truth for the API is `src/core/*.ts`.

---

## 1. Module shape

Every module is a class with a **default export** extending `BotModule`:

```ts
import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

export default class WarnModule extends BotModule {
  name = "warn";           // MUST equal the lua Module.Name
  // global = true;        // set if lua had `Module.Global = true`

  getConfigTable(): ConfigDefinition[] { return [ /* ... */ ]; }   // optional
  async onLoaded(): Promise<boolean> { /* register commands */ return true; }
}
```

Lua `Module.Name = "x"` → `name = "x"`. Lua `Module.Global = true` → `global = true`.
Lua `function Module:OnLoaded()` → `async onLoaded()`, and so on for every `Module:OnXxx`.

Lifecycle hooks (all optional): `onLoaded(): boolean`, `onUnload()`, `onEnable(guild): boolean`,
`onDisable(guild)`, `onReady()`. `onLoaded`/`onEnable` **must return true** to succeed.

**Do not modify** `src/core/*`, other modules, or shared files. Write ONLY your one
module file. If the framework seems to be missing something, use `any`/a local
workaround and note it in your report — do not edit core.

---

## 2. Config (`getConfigTable`)

Return an array of `ConfigDefinition`:

```ts
{
  Name: "WarnThreshold",
  Description: "Warns before auto-action",
  Type: ConfigType.Integer,       // Boolean|Category|Channel|Custom|Duration|Emoji|Guild|Integer|Member|Message|Number|Role|String|User
  Default: 3,
  Array?: boolean,                // lua Array=true
  ArrayMaxSize?: number,
  Global?: boolean,               // lua Global=true → stored in this.globalConfig
  Optional?: boolean,
  Sensitive?: boolean,
  ValidateValue?: (value, def) => [true] | [undefined, "err"],
}
```

Access config at runtime:
- Per-guild: `this.getConfig(guild)[ "WarnThreshold" ]`
- Global: `this.globalConfig["SomeGlobalKey"]`
- Mutable scratch data (not persisted config): `this.getData(guild)`
- Persisted data: `this.getPersistentData(guild)` (per guild) or `this.getPersistentData()` (global)

React to config changes by overriding `handleConfigUpdate(guild, config, key)`.

---

## 3. Commands

Register in `onLoaded` (lua `self:RegisterCommand`) — works for BOTH `!cmd` and `/cmd`:

```ts
this.registerCommand({
  Name: "warn",
  Args: [
    { Name: "user", Type: ConfigType.Member, Description: "User to warn" },
    { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason" },
  ],
  PrivilegeCheck: (member) => !!member?.permissions.has(PermissionFlagsBits.Administrator),
  Help: "Warns a user",
  Silent?: boolean,      // delete the invoking !message after running
  Slash?: false,         // set false to make it prefix-only (default: also a slash command)
  Func: async (ctx, user, reason) => { /* ... */ },
});
```

The first `Func` parameter is a **CommandContext** (`ctx`), NOT a message. It abstracts
`message` (prefix) and `interaction` (slash). Args come **already resolved** to runtime
values (a `GuildMember` for `ConfigType.Member`, a number for `Integer`, a `TextChannel`
for `Channel`, seconds for `Duration`, etc.) — same as lua's parsed args.

### CommandContext API (replaces the lua `message`/`commandMessage` param)

| lua | ts |
| --- | --- |
| `message:reply(x)` | `await ctx.reply(x)` |
| `message.guild` | `ctx.guild` |
| `message.member` | `ctx.member` |
| `message.author` | `ctx.author` |
| `message.channel` | `ctx.channel` |
| `message.content` | `ctx.content` (prefix only; "" for slash) |
| `message.attachments` | `ctx.attachments` (array) |
| `message:delete()` | `await ctx.delete()` |
| send without reply-ping | `await ctx.send(x)` |
| the raw message (may be undefined) | `ctx.message` |
| the raw interaction (may be undefined) | `ctx.interaction` |

`ctx.reply(...)` accepts a **string** or an options object. It understands the lua-style
`{ embed: {...} }` (singular) AND discord.js `{ embeds: [...] }`, and lua `{ file: [name, data] }`.

---

## 4. discordia → discord.js cheatsheet

Embeds: build with `EmbedBuilder`, or pass a plain object to `ctx.reply({ embed: {...} })`
(the reply shim converts `embed`→`embeds[]`). Field shape `{ name, value, inline }` is the same.

| discordia | discord.js (v14) |
| --- | --- |
| `guild:getMember(id)` | `guild.members.cache.get(id)` (or `await guild.members.fetch(id)`) |
| `guild:getChannel(id)` | `guild.channels.cache.get(id)` |
| `guild:getRole(id)` | `guild.roles.cache.get(id)` |
| `client:getUser(id)` | `this.bot.client.users.cache.get(id)` / `await ...fetch(id)` |
| `guild.roles` / `.members` / `.channels` (iterables) | `guild.roles.cache` / `.members.cache` / `.channels.cache` (Collections; `.get/.find/.filter/.map/.size/.values()`) |
| `member:hasPermission(enums.permission.administrator)` | `member.permissions.has(PermissionFlagsBits.Administrator)` |
| `member:hasRole(id)` | `member.roles.cache.has(id)` |
| `member:addRole(id)` / `removeRole(id)` | `await member.roles.add(id)` / `await member.roles.remove(id)` |
| `member:ban(reason, days)` | `await member.ban({ reason, deleteMessageSeconds })` |
| `member:kick(reason)` | `await member.kick(reason)` |
| `member:setNickname(n)` | `await member.setNickname(n)` |
| `member.user` / `.name` / `.nickname` | `member.user` / `member.displayName` / `member.nickname` |
| `role.mentionString` / `channel.mentionString` / `user.mentionString` | `role.toString()` / `channel.toString()` / `user.toString()` (or `<@id>`) |
| `user.tag` | `user.tag` (still exists) or `user.username` |
| `user.avatarURL` | `user.displayAvatarURL()` |
| `channel:send(x)` | `await channel.send(x)` |
| `channel:getMessage(id)` | `await channel.messages.fetch(id)` |
| `message:addReaction(emoji)` | `await message.react(emoji)` |
| `message:delete()` | `await message.delete()` |
| `message.author.bot` | `message.author.bot` |
| `enums.channelType.text` etc. | numeric `ChannelType.GuildText` from discord.js |
| `discordia.Color(v)` / `role:getColor():toHex()` | `role.color` (number) / `role.hexColor` (string) |
| `discordia.Date():toISO()` / timestamps | `new Date().toISOString()`; message time `message.createdTimestamp` (ms) |
| `os.time()` (unix seconds) | `import { osTime } from "../util/time"; osTime()` |
| `coroutine.wrap(fn)()` / implicit yields | just `await` — everything is async |
| `string.format("%s", x)` | template strings `` `${x}` `` |

Discord API calls (`send`, `ban`, `fetch`, `react`, ...) are **async** — `await` them and
wrap risky ones in try/catch (`.catch(() => {})` where the lua code ignored errors).

### Bot (`this.bot`) helpers ported from bot_utility.lua

- `await this.bot.decodeChannel(guild, str)` → `[channel]` | `[undefined, err]`
- `await this.bot.decodeMember(guild, str)`, `decodeRole`, `decodeUser(str)`
- `this.bot.decodeEmoji(guild, str)` (sync) → `[emojiData]` | `[undefined, err]`
- `await this.bot.decodeMessage(str, ignoreEscaped?, fullContent?)`
- `this.bot.getEmojiData(guild, idOrName)`
- `this.bot.generateMessageLink(message)`
- `this.bot.isPublicChannel(channel)`
- `this.bot.getModuleForGuild(guild, "othermodule")` → module instance or null (for cross-module calls)
- `this.bot.format(guild, "KEY", ...args)` / `this.bot.formatDuration(guild, seconds)`
- Timers: `this.bot.createRepeatTimer(intervalSec, repetitions /* -1 = forever */, cb)`,
  `this.bot.scheduleTimer(unixTs, cb)`, `this.bot.scheduleAction(unixTs, cb)`; `.stop()` a timer.
- HTTP: use global `fetch` (Node 20+), not `coro-http`.

---

## 5. Module events

Override methods named after discord.js events. Handlers only fire when the module is
enabled for the event's guild. Map from the lua `Module:OnXxx` name:

| lua hook | ts method | args |
| --- | --- | --- |
| `OnMessageCreate` | `onMessageCreate(message)` | `Message` |
| `OnMessageDelete` | `onMessageDelete(message)` | `Message` (may be partial) |
| `OnMessageUpdate` | `onMessageUpdate(oldMsg, newMsg)` | note: 2 args now |
| `OnMemberJoin` | `onGuildMemberAdd(member)` | `GuildMember` |
| `OnMemberLeave` | `onGuildMemberRemove(member)` | `GuildMember` |
| `OnMemberUpdate` | `onGuildMemberUpdate(oldMember, newMember)` | 2 args |
| `OnReactionAdd` | `onMessageReactionAdd(reaction, user)` | `MessageReaction, User` |
| `OnReactionRemove` | `onMessageReactionRemove(reaction, user)` | |
| `OnUserBan` | `onGuildBanAdd(ban)` | `GuildBan` (`.user`, `.guild`) |
| `OnUserUnban` | `onGuildBanRemove(ban)` | |
| `OnChannelCreate/Delete` | `onChannelCreate/onChannelDelete(channel)` | |
| `OnRoleCreate/Delete/Update` | `onRoleCreate/onRoleDelete/onRoleUpdate` | update = 2 args |
| `OnVoiceChannelJoin/Leave/Update` | `onVoiceStateUpdate(oldState, newState)` | derive join/leave from states |
| `OnPresenceUpdate` | `onPresenceUpdate(oldPresence, newPresence)` | |
| `OnTypingStart` | `onTypingStart(typing)` | `Typing` |
| `OnInteractionCreate` | `onInteractionCreate(interaction)` | prefer the router below |

(Full list in `src/core/events.ts`.)

---

## 6. Modern interactions (buttons / select menus / modals / autocomplete)

Register handlers in `onLoaded` via `this.bot.interactions`:

```ts
this.bot.interactions.registerComponent("poll_vote_", async (interaction) => {
  // interaction.customId starts with "poll_vote_"
  await interaction.reply({ content: "voted", ephemeral: true });
});
this.bot.interactions.registerModal("modmail_reply_", async (interaction) => {
  const text = interaction.fields.getTextInputValue("body");
});
this.bot.interactions.registerAutocomplete("mycommand", async (interaction) => {
  await interaction.respond([{ name: "opt", value: "opt" }]);
});
```

Build components with `ActionRowBuilder`, `ButtonBuilder`, `StringSelectMenuBuilder`,
`ModalBuilder`, `TextInputBuilder`. If the lua sent raw component JSON
(`{ type = enums.componentType.button, ... }`), you can keep the plain object shape —
discord.js accepts API-style component objects too.

---

## 7. Persistence

Config/persistent data are auto-loaded on boot and auto-saved every 5 min + on shutdown.
Mutate `this.getConfig(guild)` / `this.getPersistentData(guild)` / `this.globalConfig` in
place; call `await this.saveGuildConfig(guild)` / `await this.savePersistentData(guild)` /
`await this.saveGlobalConfig()` when you want an immediate write (lua `self:SaveGuildConfig`).

---

## 8. Rules for the port

1. Produce valid TypeScript that compiles under the (lenient) tsconfig. `any` is fine at
   discord.js boundaries; correctness of behavior matters more than perfect types.
2. Keep behavior faithful to the lua. Preserve command names, arg order, permissions,
   messages, and config keys/defaults exactly.
3. `await` all Discord API + storage calls.
4. Only write `src/modules/<name>.ts`. Never touch core or other modules.
5. If something can't be faithfully ported (missing lua helper, external dep), stub it
   sensibly, add a `// TODO(port):` comment, and report it.

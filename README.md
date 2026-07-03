# NotaBot-TS

A TypeScript rewrite of **Not a Bot** (the moderation/utility bot of the NaN
programming Discord) on **discord.js v14** and **Node.js 20+**, ported from the
original Lua/discordia codebase (preserved in the repo's git history / upstream Lua branches).

## What's new vs the Lua bot

- **TypeScript** end-to-end, with a typed module + command framework.
- **Slash commands** (`/warn`, `/poll`, …) auto-generated from the same command
  definitions that power the legacy **`!prefix`** commands — both work side by side.
- **Modern interactions**: buttons, select menus, **modals ("forms")**, and
  autocomplete are first-class (`bot.interactions.register*`). The built-in
  `/configedit` opens a modal to edit a module's config value; `help` paginates
  with buttons.
- Same on-disk data layout (`data/module_<name>/...`) as the Lua bot.

## Setup

```bash
pnpm install
cp .env.example .env      # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_USER_ID
pnpm dev                  # run with hot reload (tsx)
# or
pnpm build && pnpm start  # compile to dist/ and run with node
```

Slash commands are registered automatically on startup. To (re)deploy them
without starting the gateway: `pnpm deploy-commands`. Set `DEV_GUILD_ID` in `.env`
to register instantly to a single test guild during development (global
registration can take up to an hour to propagate).

## Project layout

```
src/
  index.ts              bootstrap (loads config, client, modules, dispatch)
  config.ts             env-based configuration (replaces config.lua)
  core/
    bot.ts              central registry + decode/persistence/timer helpers  (bot.lua, bot_utility.lua)
    module.ts           BotModule base class: config/data/lifecycle           (bot_modules.lua)
    moduleLoader.ts     module registration + ready bootstrap
    command.ts          CommandContext (unifies message + interaction) + reply shim
    commandDispatcher.ts prefix + slash dispatch                              (bot_commands.lua)
    configTypes.ts      the ConfigType system (parsers/serializers/validators) (bot.lua)
    slashRegistry.ts    builds & registers slash commands via REST
    interactions.ts     button / select / modal / autocomplete router
    events.ts           routes discord.js events to module hooks             (bot_modules.lua)
    timer.ts            scheduler                                            (bot_timers.lua)
    storage.ts          JSON persistence                                     (bot_utility.lua)
    localization.ts     i18n                                                 (bot_localization.lua)
    emoji.ts            emoji resolution                                     (bot_emoji.lua)
    client.ts           discord.js client + gateway intents
  commands/builtin.ts   help, config, configedit (modal), module management, owner cmds
  modules/*.ts          the feature modules (one file per module_*.lua)
  util/                 time, args, snowflake helpers
  scripts/              deployCommands, convertEmoji
```

## Writing / porting a module

See **[FRAMEWORK.md](./FRAMEWORK.md)** for the full API and the discordia →
discord.js cheatsheet, and `src/modules/_template.ts` for a skeleton.

## Status

This is a mechanical + semantic port verified to **compile** (`pnpm typecheck`).
It has **not** been runtime-tested against a live Discord connection — see
[MIGRATION.md](./MIGRATION.md) for the port status per module and the remaining
verification checklist.

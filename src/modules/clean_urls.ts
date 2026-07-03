// Ported from module_clean_urls.lua — strips tracking/unwanted query parameters
// from URLs posted in chat (or via the `cleanurl` command), replacing the
// original message with a cleaned one mimicked through a per-channel webhook so
// the conversation flow (author name/avatar) is preserved.
//
// `data_linkshorteners.lua` was read as instructed, but its only use-site in the
// lua source (`Module:Replacer`'s link-shortener-resolution block, and the
// `resolveLocation` helper that backed it) is entirely commented out in the lua
// module, so there is nothing live to port for it.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType } from "../core/configTypes";
import { osTime } from "../util/time";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type Webhook,
} from "discord.js";

// --- Rule compilation --------------------------------------------------------
//
// Lua rules are strings of the form "param" (applies to every host) or
// "param@host" (applies only when the URL host matches `host`), where both
// `param` and `host` may contain `*` as a lazy/greedy wildcard. The lua source
// built these into hand-escaped Lua *patterns*; here we build equivalent JS
// RegExp sources instead. The escaping scheme mirrors the lua one closely
// enough that the lua algorithm's (several) dead/no-op steps stay dead here
// too — see the comments on `buildHostPattern` for specifics.

interface CompiledRule {
  /** The compiled regex source (kept around because lua's `removeParam` also
   *  compared the raw param name against this — see `removeParam` below). */
  source: string;
  regex: RegExp;
}

interface HostRuleBucket {
  hostRegex: RegExp;
  rules: CompiledRule[];
}

/** Mirrors lua's `regExpChars` class: \ ^ $ . * + - ? ( ) [ ] { } | */
function escapeRegexChars(str: string): string {
  return str.replace(/[\\^$.*+\-?()[\]{}|]/g, "\\$&");
}

function buildParamPattern(paramPart: string): CompiledRule {
  const source = `^${escapeRegexChars(paramPart).replace(/\\\*/g, ".*?")}$`;
  return { source, regex: new RegExp(source) };
}

function buildHostPattern(hostPart: string): CompiledRule {
  const escaped = escapeRegexChars(hostPart).replace(/\\\*/g, ".*?");
  // lua prefixed the host pattern with "^(w*%.?)", presumably meant as an
  // optional "www." prefix but actually matching zero-or-more literal 'w'
  // characters followed by an optional dot (NOT the literal word "www").
  // Reproduced verbatim for fidelity rather than "fixed".
  const source = `^(w*\\.?)(${escaped})$`;
  return { source, regex: new RegExp(source) };
}

/** Ported from `Module:CreateRules` / `Module:CreateGuildRules` (shared logic;
 *  the lua source duplicated this near-identically between the two). When
 *  `seed` is supplied, new rules are appended onto it in place -- lua's
 *  `CreateGuildRules` re-compiles the *entire* `config.Rules` array on every
 *  call and appends onto whatever was already cached, so repeated calls (e.g.
 *  via `addcleanrule`) accumulate duplicate compiled entries for
 *  already-known rules. That's harmless (matching stays idempotent) but is
 *  reproduced verbatim rather than fixed. */
function compileRules(
  rules: string[],
  seed?: { universal: CompiledRule[]; hostMap: Map<string, HostRuleBucket> },
): { universal: CompiledRule[]; hostMap: Map<string, HostRuleBucket> } {
  const universal = seed?.universal ?? [];
  const hostMap = seed?.hostMap ?? new Map<string, HostRuleBucket>();

  for (const rule of rules) {
    const parts = rule.split("@");
    const paramPart = parts[0];
    const hostPart = parts[1];

    if (hostPart === undefined) {
      universal.push(buildParamPattern(paramPart));
    } else {
      const hostPattern = buildHostPattern(hostPart);
      let bucket = hostMap.get(hostPattern.source);
      if (!bucket) {
        bucket = { hostRegex: hostPattern.regex, rules: [] };
        hostMap.set(hostPattern.source, bucket);
      }
      bucket.rules.push(buildParamPattern(paramPart));
    }
  }

  return { universal, hostMap };
}

// --- `!listcleanrules` ANSI pretty-printer -----------------------------------

const ANSI_FG: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
};

/** Ported from lua's local `formatRule`. */
function formatRule(rule: string): string {
  const parts = rule.split("@");
  const param = parts[0];
  const hostPart = parts[1];

  if (hostPart === undefined) {
    return `\x1b[${ANSI_FG.green}m${param}\x1b[0m`;
  }

  const colour = param === "*" ? ANSI_FG.cyan : ANSI_FG.green;
  // NOTE(port): faithfully reproduces a lua display quirk -- only the first
  // two dot-separated host segments are shown, so a 3+-segment host like
  // "*.aliexpress.com" is displayed as "*.aliexpress" (the ".com" TLD is
  // silently dropped). This only affects the `!listcleanrules` pretty-print;
  // the actual URL-cleaning matching logic is unaffected.
  const splitted = hostPart.split(".");

  return (
    `\x1b[${colour}m${param}\x1b[0m` +
    `\x1b[${ANSI_FG.magenta}m@\x1b[0m` +
    `\x1b[${ANSI_FG.yellow}m${splitted[0]}\x1b[0m` +
    `\x1b[${ANSI_FG.blue}m.\x1b[0m` +
    `\x1b[${ANSI_FG.red}m${splitted[1]}\x1b[0m`
  );
}

// --- Built-in data (ported verbatim from Module.DefaultRules / FixServices) --

const DEFAULT_RULES: string[] = [
  "action_object_map",
  "action_type_map",
  "action_ref_map",
  "spm@*.aliexpress.com",
  "scm@*.aliexpress.com",
  "aff_platform",
  "aff_trace_key",
  "algo_expid@*.aliexpress.*",
  "algo_pvid@*.aliexpress.*",
  "btsid",
  "ws_ab_test",
  "pd_rd_*@amazon.*",
  "_encoding@amazon.*",
  "psc@amazon.*",
  "tag@amazon.*",
  "ref_@amazon.*",
  "pf_rd_*@amazon.*",
  "pf@amazon.*",
  "crid@amazon.*",
  "keywords@amazon.*",
  "sprefix@amazon.*",
  "smid@amazon.*",
  "creative*@amazon.*",
  "th@amazon.*",
  "linkCode@amazon.*",
  "sr@amazon.*",
  "ie@amazon.*",
  "node@amazon.*",
  "qid@amazon.*",
  "dib@amazon.*",
  "dib_tag@amazon.*",
  "ref@amazon.*",
  "callback@bilibili.com",
  "cvid@bing.com",
  "form@bing.com",
  "sk@bing.com",
  "sp@bing.com",
  "sc@bing.com",
  "qs@bing.com",
  "pq@bing.com",
  "sc_cid",
  "mkt_tok",
  "trk",
  "trkCampaign",
  "ga_*",
  "gclid",
  "gclsrc",
  "hmb_campaign",
  "hmb_medium",
  "hmb_source",
  "spReportId",
  "spJobID",
  "spUserID",
  "spMailingID",
  "itm_*",
  "s_cid",
  "elqTrackId",
  "elqTrack",
  "assetType",
  "assetId",
  "recipientId",
  "campaignId",
  "siteId",
  "mc_cid",
  "mc_eid",
  "pk_*",
  "sc_campaign",
  "sc_channel",
  "sc_content",
  "sc_medium",
  "sc_outcome",
  "sc_geo",
  "sc_country",
  "nr_email_referer",
  "vero_conv",
  "vero_id",
  "yclid",
  "_openstat",
  "mbid",
  "cmpid",
  "cid",
  "c_id",
  "campaign_id",
  "Campaign",
  "hash@ebay.*",
  "fb_action_ids",
  "fb_action_types",
  "fb_ref",
  "fb_source",
  "fbclid",
  "refsrc@facebook.com",
  "hrc@facebook.com",
  "gs_l",
  "gs_lcp@google.*",
  "ved@google.*",
  "ei@google.*",
  "sei@google.*",
  "gws_rd@google.*",
  "gs_gbg@google.*",
  "gs_mss@google.*",
  "gs_rn@google.*",
  "_hsenc",
  "_hsmi",
  "__hssc",
  "__hstc",
  "hsCtaTracking",
  "source@sourceforge.net",
  "position@sourceforge.net",
  "t@*.twitter.com",
  "s@*.twitter.com",
  "ref_*@*.twitter.com",
  "t@*.x.com",
  "s@*.x.com",
  "ref_*@*.x.com",
  "t@*.fixupx.com",
  "s@*.fixupx.com",
  "ref_*@*.fixupx.com",
  "t@*.fxtwitter.com",
  "s@*.fxtwitter.com",
  "ref_*@*.fxtwitter.com",
  "t@*.twittpr.com",
  "s@*.twittpr.com",
  "ref_*@*.twittpr.com",
  "t@*.fixvx.com",
  "s@*.fixvx.com",
  "ref_*@*.fixvx.com",
  "tt_medium",
  "tt_content",
  "lr@yandex.*",
  "redircnt@yandex.*",
  "feature@*.youtube.com",
  "kw@*.youtube.com",
  "si@*.youtube.com",
  "pp@*.youtube.com",
  "si@*.youtu.be",
  "wt_zmc",
  "utm_source",
  "utm_content",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "si@open.spotify.com",
  "igshid",
  "igsh",
  "share_id@reddit.com",
];

const FIX_SERVICES: Record<string, string> = {
  "bsky.app": "bskyx.app",
  // Currently broken
  // "deviantart.com": "fxdeviantart.com",
  "instagram.com": "ddinstagram.com",
  "pixiv.net": "ppxiv.net",
  "reddit.com": "rxddit.com",
  // Currently broken
  "threads.net": "fixthreads.net",
  "tiktok.com": "tnktok.com",
  "tumblr.com": "tpmblr.com",
  "twitch.tv": "fxtwitch.tv",
  // Use vxtwitter instead of fxtwitter since it includes greedy analytics
  "twitter.com": "vxtwitter.com",
  "x.com": "fixvx.com",
};

export default class CleanUrlsModule extends BotModule {
  name = "clean_urls";

  /** Lua `Module.UsersHanging` -- tracks users who have a webhook message
   *  hanging with an active delete button. */
  private usersHanging = new Set<string>();

  /** Lua `Module.UniversalRules` / `Module.HostRules` / `Module.RulesByHost`
   *  -- built once (from `DEFAULT_RULES`) in `onLoaded`/`createRules`. */
  private universalRules: CompiledRule[] = [];
  private hostRules = new Map<string, HostRuleBucket>();

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Name: "AutoCleanUrls",
        Description: "Should clean urls when an user posts a message link (when not using clean command)",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "DeleteInvokationOnAutoCleanUrls",
        Description: "Deletes the message that invoked the clean urls when auto-cleaning urls",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "DeleteInvokationOnManualCleanUrls",
        Description: "Deletes the message that invoked the clean urls when cleaning urls via command",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Name: "WebhooksMappings",
        Description: "The webhook id to use for cleaning urls",
        Type: ConfigType.Custom,
        Default: {},
        ValidateConfig: (value: any) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return [undefined, "Value must be a table"];
          }
          for (const [channelId, webhookId] of Object.entries(value)) {
            if (typeof channelId !== "string" || typeof webhookId !== "string") {
              return [undefined, "Value must be a table with string keys and string values"];
            }
          }
          return [true];
        },
      },
      {
        Name: "Rules",
        Description: "The rules to use for cleaning urls",
        Type: ConfigType.String,
        Default: [],
        Array: true,
      },
      {
        Name: "Whitelist",
        Description: "List of URL hosts to whitelist, e.g google.com",
        Type: ConfigType.String,
        Default: [],
        Array: true,
      },
      {
        Name: "ButtonTimeout",
        Description: "The time, in milliseconds after which the delete button will disappear",
        Type: ConfigType.Integer,
        Default: 10000,
      },
    ];
  }

  async onLoaded(): Promise<boolean> {
    this.createRules();

    this.registerCommand({
      Name: "cleanurl",
      Args: [
        { Name: "url", Description: "The URL to clean", Type: ConfigType.String },
        {
          Name: "deleteInvokation",
          Description: "Delete the message that invoked the command",
          Type: ConfigType.Boolean,
          Optional: true,
        },
      ],
      Func: async (ctx, url: string, deleteInvokation: boolean | undefined) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const data = this.getData(guild)!;
        const replaced = this.replacer(url, config, data);

        if (replaced) await ctx.reply(replaced);
        if (deleteInvokation) await ctx.delete();
      },
    });

    this.registerCommand({
      Name: "addcleanrules",
      Args: [{ Name: "rules", Description: "The rules to add, separated by commas", Type: ConfigType.String }],
      Func: async (ctx, rules: string | undefined) => {
        const guild = ctx.guild!;
        if (!rules) {
          return ctx.reply(this.bot.format(guild, "CLEAN_URLS_NO_RULES_PROVIDED"));
        }

        const splittedRules = rules.split(",");
        await this.addRules(splittedRules, guild);
        // NOTE(port): lua called `Bot:Format(cmd.guild, 'CLEAN_URLS_RULES_ADDED')`
        // without the value for the localization string's `%s` placeholder
        // ("Added rules: %s"), which would throw in lua (string.format with a
        // missing argument). Passing the joined rule list here instead, to
        // produce the obviously-intended confirmation message.
        await ctx.reply(this.bot.format(guild, "CLEAN_URLS_RULES_ADDED", splittedRules.join(", ")));
      },
    });

    this.registerCommand({
      Name: "addcleanrule",
      Args: [{ Name: "rule", Description: "The rule to add", Type: ConfigType.String }],
      Func: async (ctx, rule: string | undefined) => {
        const guild = ctx.guild!;
        if (!rule) {
          return ctx.reply(this.bot.format(guild, "CLEAN_URLS_NO_RULE_PROVIDED"));
        }

        await this.addRules([rule], guild);
        await ctx.reply(this.bot.format(guild, "CLEAN_URLS_RULE_ADDED", rule));
      },
    });

    this.registerCommand({
      Name: "removecleanrule",
      Args: [{ Name: "rule", Description: "The rule to remove", Type: ConfigType.String }],
      Func: async (ctx, rule: string | undefined) => {
        const guild = ctx.guild!;
        if (!rule) {
          return ctx.reply(this.bot.format(guild, "CLEAN_URLS_NO_RULE_PROVIDED"));
        }

        const config = this.getConfig(guild)!;
        const rules: string[] = config.Rules ?? [];
        const idx = rules.indexOf(rule);
        if (idx !== -1) rules.splice(idx, 1);

        // NOTE(port): lua called `self:CreateGuildRules(config, cmd.guild.id)`
        // here, passing the guild *id string* instead of the guild Data table
        // (`self:GetData(cmd.guild)`). Since `CreateGuildRules` writes fields
        // onto its `data` argument, that would crash in lua ("attempt to index
        // a string value") every time this command ran. Fixed to pass the
        // actual guild Data table.
        await this.createGuildRules(config, this.getData(guild)!);
        await this.saveGuildConfig(guild);
        await ctx.reply(this.bot.format(guild, "CLEAN_URLS_RULE_REMOVED", rule));
      },
    });

    this.registerCommand({
      Name: "clearcleanrules",
      Args: [],
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        config.Rules = [];
        // NOTE(port): same guild.id-instead-of-Data-table bug as
        // `removecleanrule` above (`self:ClearGuildRules(config, cmd.guild.id)`
        // in lua); fixed to pass the actual guild Data table.
        await this.clearGuildRules(this.getData(guild)!);
        await this.saveGuildConfig(guild);
        await ctx.reply(this.bot.format(guild, "CLEAN_URLS_RULES_CLEARED"));
      },
    });

    this.registerCommand({
      Name: "listcleanrules",
      Args: [],
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const rules: string[] = config.Rules ?? [];

        if (rules.length === 0) {
          return ctx.reply(this.bot.format(guild, "CLEAN_URLS_NO_RULES"));
        }

        let result = `## ${this.bot.format(guild, "CLEAN_URLS_RULES_HEADER")}\n\`\`\`ansi\n`;
        rules.forEach((rule, i) => {
          result += `${i + 1}. ${formatRule(rule)}\n`;
        });
        result += "```";

        await ctx.reply(result);
      },
    });

    // Lua `Module:OnInteractionCreate`, routed by custom_id prefix. The
    // interaction router isn't gated by module-enabled state the way
    // discord.js-event hooks are, so we re-check `isEnabledForGuild` to match
    // the implicit gating the lua module got from bot_modules.lua.
    this.bot.interactions.registerComponent("delete_", async (interaction) => {
      if (!interaction.isButton()) return;
      const guild = interaction.guild;
      if (guild && !this.isEnabledForGuild(guild)) return;

      const authorId = interaction.customId.slice("delete_".length);
      if (!/^\d+$/.test(authorId)) return;

      const interactionAuthorId = interaction.user.id;
      const member = interaction.member as GuildMember | null;
      const hasManageMessages = member
        ? member.permissionsIn(interaction.channelId).has(PermissionFlagsBits.ManageMessages)
        : false;

      if (authorId !== interactionAuthorId && !hasManageMessages) {
        await interaction
          .reply({ content: this.bot.format(guild, "CLEAN_URLS_WRONG_USER_BUTTON"), ephemeral: true })
          .catch(() => {});
        return;
      }

      if (interaction.message) {
        await interaction.message.delete().catch(() => {});
      }

      await interaction
        .reply({ content: this.bot.format(guild, "CLEAN_URLS_DELETED_MESSAGE"), ephemeral: true })
        .catch(() => {});

      this.usersHanging.delete(authorId);
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const config = this.getConfig(guild)!;
    const data = this.getData(guild)!;

    const rules: string[] = config.Rules ?? [];
    if (rules.length === 0) return true;

    await this.createGuildRules(config, data);
    return true;
  }

  async onMessageCreate(message: Message): Promise<void> {
    const guild = message.guild;
    // NOTE(port): lua's guard here was
    //   `if not message.channel.type == enums.channelType.text and not message.guild then return end`
    // Due to lua operator precedence `not X == Y` parses as `(not X) == Y`,
    // and since `message.channel.type` is always a truthy number, `not
    // message.channel.type` is always `false`, and `false == <a channel type
    // number>` is always `false` too -- so the left side of the `and` is
    // always false and this guard never actually filtered anything (it's dead
    // code). This reproduces the clearly-intended behaviour (skip messages
    // with no guild, e.g. DMs) instead of faithfully reproducing a crash a few
    // lines down where `self:GetConfig(nil)` would error.
    if (!guild) return;

    const channel = message.channel as any;
    const isThread = typeof channel.isThread === "function" && channel.isThread();
    const realChannel: any = isThread ? (guild.channels.cache.get(channel.parentId) ?? channel) : channel;

    const config = this.getConfig(guild)!;
    const data = this.getData(guild)!;

    if (message.author.bot || message.webhookId) return;
    if (!config.AutoCleanUrls) return;

    const replaced = this.cleanMessage(message, config, data);
    if (replaced === undefined || replaced === message.content) return;

    const attachmentFiles: AttachmentBuilder[] = [];
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        const res = await fetch(attachment.url).catch(() => undefined);
        if (res && res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          attachmentFiles.push(new AttachmentBuilder(buf, { name: attachment.name }));
        }
      }
    }

    if (config.DeleteInvokationOnAutoCleanUrls) {
      await message.delete().catch(() => {});
    }

    const webhook = await this.getWebhook(guild, realChannel);

    const threadId: string | undefined = realChannel.id !== message.channel.id ? message.channel.id : undefined;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`delete_${message.author.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel(this.bot.format(guild, "CLEAN_URLS_DELETE_BUTTON_LABEL")),
    );

    const sentMessage = await webhook.send({
      avatarURL: message.author.displayAvatarURL(),
      username: message.author.globalName ?? message.author.username,
      content: replaced,
      components: [row],
      files: attachmentFiles,
      threadId,
    });

    this.usersHanging.add(message.author.id);

    // NOTE(port): lua computed the disappearance time as
    // `os.time() + (config.ButtonTimeout or 10000)`, adding `ButtonTimeout`
    // (documented, and defaulted to 10000, as *milliseconds*) directly onto a
    // unix-*seconds* timestamp with no unit conversion. So the delete button
    // actually stays up for ~ButtonTimeout *seconds* (~2.78 hours at the
    // default of 10000), not ButtonTimeout milliseconds as the config
    // description says. Reproduced verbatim.
    const deleteTimeout = config.ButtonTimeout || 10000;
    this.bot.scheduleAction(osTime() + deleteTimeout, async () => {
      if (this.usersHanging.has(message.author.id)) {
        await webhook.editMessage(sentMessage.id, { components: [], threadId });
        this.usersHanging.delete(message.author.id);
      }
    });
  }

  // --- Rule management (ported from Module:CreateRules / CreateGuildRules /
  // ClearGuildRules / AddRules) ------------------------------------------------

  private createRules() {
    const { universal, hostMap } = compileRules(DEFAULT_RULES);
    this.universalRules = universal;
    this.hostRules = hostMap;
  }

  private async createGuildRules(config: Record<string, any>, data: Record<string, any>) {
    const rules: string[] = config.Rules ?? [];
    const seed = {
      universal: (data.GuildUniversalRules as CompiledRule[] | undefined) ?? [],
      hostMap: (data.GuildHostRules as Map<string, HostRuleBucket> | undefined) ?? new Map<string, HostRuleBucket>(),
    };

    const { universal, hostMap } = compileRules(rules, seed);

    data.GuildUniversalRules = universal;
    data.GuildHostRules = hostMap;

    // Lua literally calls the *global* `Bot:Save()` here (saves persistent
    // data for every loaded module), not just this guild's config. Reproduced
    // verbatim even though it looks unnecessarily broad.
    await this.bot.save();
  }

  private async clearGuildRules(data: Record<string, any>) {
    delete data.GuildUniversalRules;
    delete data.GuildHostRules;
    await this.bot.save();
  }

  private async addRules(rules: string[], guild: Guild) {
    const guildData = this.getGuildData(guild.id)!;
    const config = guildData.Config;
    const data = guildData.Data;

    config.Rules = config.Rules ?? [];
    for (const rule of rules) config.Rules.push(rule);

    await this.createGuildRules(config, data);
    await this.saveGuildConfig(guild);
  }

  // --- URL cleaning -----------------------------------------------------------

  /** Ported from `Module:Replacer`. */
  private replacer(match: string, config: Record<string, any>, data: Record<string, any>): string {
    const m = match.match(/^(https?:\/\/)([^/]+)(\/[^?]*)([\s\S]*)$/);
    if (!m) return match;
    const [, protocol, host, path, queryString] = m;

    const whitelist: string[] = config.Whitelist ?? [];
    for (const rule of whitelist) {
      try {
        if (new RegExp(rule).test(host)) return match;
      } catch {
        // Malformed whitelist entry (invalid regex). Lua patterns can't fail
        // to compile the same way JS RegExp can; skip rather than crash the
        // whole clean pipeline over one bad config entry.
      }
    }

    const fix = FIX_SERVICES[host];
    if (fix) {
      // lua did `host:gsub(host, fix)` -- a self-matching gsub where the
      // pattern (the host string itself) always matches the whole `host`
      // string, so it reduces to simply replacing the whole host with `fix`.
      return `${protocol}${fix}${path}${queryString}`;
    }

    if (!queryString || queryString.length === 0 || queryString === "?") {
      return match;
    }

    const queryParams: Record<string, string> = {};
    const paramRe = /([^&=]+)=([^&]*)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(queryString.slice(1)))) {
      queryParams[pm[1]] = pm[2];
    }

    const removeParam = (rule: CompiledRule, param: string) => {
      // lua's `removeParam` also compared the raw param name against the
      // *compiled* pattern string directly (`param == rule`). That's
      // effectively always false in practice (query param names don't
      // literally equal e.g. "^utm_source$"), but reproduced verbatim.
      if (param === rule.source || rule.regex.test(param)) delete queryParams[param];
    };
    const applyRules = (rules: CompiledRule[]) => {
      for (const rule of rules) {
        for (const param of Object.keys(queryParams)) removeParam(rule, param);
      }
    };

    applyRules(this.universalRules);
    applyRules((data.GuildUniversalRules as CompiledRule[] | undefined) ?? []);

    for (const bucket of this.hostRules.values()) {
      if (bucket.hostRegex.test(host)) applyRules(bucket.rules);
    }
    const guildHostRules = data.GuildHostRules as Map<string, HostRuleBucket> | undefined;
    if (guildHostRules) {
      for (const bucket of guildHostRules.values()) {
        if (bucket.hostRegex.test(host)) applyRules(bucket.rules);
      }
    }

    const newQueryString = Object.entries(queryParams)
      .map(([key, value]) => `${key}=${value}`)
      .join("&");

    return `${protocol}${host}${path ?? ""}${newQueryString !== "" ? "?" + newQueryString : ""}`;
  }

  /** Ported from `Module:CleanMessage`. */
  private cleanMessage(message: Message, config: Record<string, any>, data: Record<string, any>): string | undefined {
    if (!this.bot.isPublicChannel(message.channel as any)) return undefined;
    if (message.content.startsWith(this.bot.config.prefix)) return undefined;
    if (!/https?:\/\//.test(message.content)) return undefined;

    return message.content.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"'>)|\]])/g, (matched) =>
      this.replacer(matched, config, data),
    );
  }

  /** Ported from `Module:GetWebhook`. */
  private async getWebhook(guild: Guild, channel: any): Promise<Webhook> {
    const config = this.getConfig(guild)!;
    config.WebhooksMappings = config.WebhooksMappings ?? {};

    const webhookId = config.WebhooksMappings[channel.id];
    if (!webhookId) {
      const webhook = await channel.createWebhook({ name: this.bot.format(guild, "CLEAN_URLS_AUDITLOG") });
      config.WebhooksMappings[channel.id] = webhook.id;
      await this.saveGuildConfig(guild);
      return webhook;
    }

    return await this.bot.client.fetchWebhook(webhookId);
  }
}

// Ported from module_raid.lua — anti-raid protections: lock/unlock the server,
// custom join rules (authorize/ban/kick based on account signals), join-spam
// auto-lock, and message-spam auto-mute/ban for brand-new members.

import { BotModule, type ConfigDefinition } from "../core/module";
import { ConfigType, type ParseResult, ok, fail } from "../core/configTypes";
import {
  PermissionFlagsBits,
  GuildVerificationLevel,
  UserFlagsBitField,
  MessageType,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import { osTime, discordRelativeTime } from "../util/time";

// --- small lua-stdlib shims (util.MemberHasAnyRole / math.clamp) -----------

function memberHasAnyRole(member: GuildMember, roleIds: string[] | undefined): boolean {
  if (!roleIds) return false;
  for (const roleId of roleIds) {
    if (member.roles.cache.has(roleId)) return true;
  }
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// Stand-in for Lua's `math.huge`. A real `Infinity` doesn't survive
// `JSON.stringify` (it becomes `null`), so a "permanent lock" wouldn't persist
// across a restart. MAX_SAFE_INTEGER is always > osTime() yet round-trips fine.
const INFINITE_LOCK = Number.MAX_SAFE_INTEGER;

// --- rule parameter helpers --------------------------------------------------

function parseBooleanParam(param: string): ParseResult<boolean> {
  if (param === "yes" || param === "1" || param === "true") return ok(true);
  if (param === "no" || param === "0" || param === "false") return ok(false);
  return fail("expected a boolean (yes/no)");
}

// Mirrors discordia's `Date.parseISO`: "YYYY-MM-DD<sep>HH:MM:SS", UTC.
function parseISODateSeconds(str: string): number | undefined {
  const m = str.match(/(\d+)-(\d+)-(\d+).(\d+):(\d+):(\d+)/);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function formatISODateSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const hypesquadFlags =
  UserFlagsBitField.Flags.Hypesquad |
  UserFlagsBitField.Flags.HypeSquadOnlineHouse1 |
  UserFlagsBitField.Flags.HypeSquadOnlineHouse2 |
  UserFlagsBitField.Flags.HypeSquadOnlineHouse3;

interface RuleDef {
  description: string;
  parameters: string;
  parse: (param: string) => ParseResult<any>;
  toString: (config: any) => string;
  check: (member: GuildMember, config: any) => boolean;
}

const rules: Record<string, RuleDef> = {
  nitro: {
    description: "checks if the user account has nitro",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => {
      // NOTE(port): Discord's API does not expose another user's Nitro
      // subscription type to bots (only available for the bot's own user via
      // OAuth /users/@me), so `premiumType` is effectively never populated
      // here. This mirrors the same limitation the Lua bot had (discordia's
      // `member.premiumType` reads a field Discord doesn't send for others).
      const premiumType = (member.user as any).premiumType ?? (member.user as any).premium_type;
      return premiumType === 1 /* nitroClassic */ || premiumType === 2 /* nitro */;
    },
  },
  hypesquad: {
    description: "checks if the user is registered for the hypesquad",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => {
      const flags = member.user.flags?.bitfield ?? 0;
      return (flags & hypesquadFlags) !== 0;
    },
  },
  discordEmployee: {
    description: "checks if the user is a Discord employee",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => !!member.user.flags?.has(UserFlagsBitField.Flags.Staff),
  },
  discordPartner: {
    description: "checks if the user is a Discord partner",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => !!member.user.flags?.has(UserFlagsBitField.Flags.Partner),
  },
  earlySupporter: {
    description: "checks if the user is a Discord early supporter",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => !!member.user.flags?.has(UserFlagsBitField.Flags.PremiumEarlySupporter),
  },
  verifiedBotDeveloper: {
    description: "checks if the user is a verified Discord developer",
    parameters: "<bool>",
    parse: parseBooleanParam,
    toString: (v) => String(v),
    check: (member) => !!member.user.flags?.has(UserFlagsBitField.Flags.VerifiedDeveloper),
  },
  createdBetween: {
    description: "checks if the user was created in a date range",
    parameters: "<ISO 8601 from date> => <ISO 8601 to date>",
    parse: (param) => {
      const m = param.match(/^(.+)\s*=>\s*(.+)$/);
      if (!m) return fail("please set two dates in ISO 8601 separated by a => (from => to)");
      const from = parseISODateSeconds(m[1]);
      const to = parseISODateSeconds(m[2]);
      if (from === undefined || to === undefined) return fail("invalid date, please write it in ISO 8601 format");
      return ok({ from, to });
    },
    toString: (config) => `${formatISODateSeconds(config.from)} => ${formatISODateSeconds(config.to)}`,
    check: (member, config) => {
      const creationDate = Math.floor(member.user.createdTimestamp / 1000);
      return creationDate >= config.from && creationDate <= config.to;
    },
  },
  olderThan: {
    description: "checks if the user was created before a specific date",
    parameters: "<ISO 8601 date>",
    parse: (param) => {
      const time = parseISODateSeconds(param);
      if (time === undefined) return fail("invalid date, please write it in ISO 8601 format");
      return ok(time);
    },
    toString: (config) => formatISODateSeconds(config),
    check: (member, config) => {
      const creationDate = Math.floor(member.user.createdTimestamp / 1000);
      return creationDate <= config;
    },
  },
  newerThan: {
    description: "checks if the user was created after a specific date",
    parameters: "<ISO 8601 date>",
    parse: (param) => {
      const time = parseISODateSeconds(param);
      if (time === undefined) return fail("invalid date, please write it in ISO 8601 format");
      return ok(time);
    },
    toString: (config) => formatISODateSeconds(config),
    check: (member, config) => {
      const creationDate = Math.floor(member.user.createdTimestamp / 1000);
      return creationDate >= config;
    },
  },
  nicknameContains: {
    description: "checks if the user nickname contains something (case-insensitive)",
    parameters: "<nickname>",
    parse: (param) => {
      if (!param || param.length === 0) return fail("invalid nickname");
      if (param.slice(0, 2) === "p:") {
        const pattern = param.slice(2);
        try {
          new RegExp(pattern);
        } catch {
          return fail("invalid pattern");
        }
        return ok({ p: true, str: pattern });
      }
      return ok({ p: false, str: param });
    },
    toString: (config) => (config.p ? "pattern: " : "") + config.str,
    check: (member, config) => {
      // NOTE(port): the Lua source actually reads `member.user.name` (the
      // account's global username), not the guild nickname, despite the rule
      // name. Preserved as-is. Matching is case-sensitive against the
      // already-lowercased name, exactly like the Lua `:match`/`:find`.
      const name = member.user.username.toLowerCase();
      if (config.p) {
        try {
          return new RegExp(config.str).test(name);
        } catch {
          return false;
        }
      }
      return name.includes(config.str);
    },
  },
};

const effects: Record<string, string> = {
  authorize: "Allow the user to join the server if it's locked.",
  ban: "Bans the user on join.",
  kick: "Prevents the user from joining (even if the server isn't locked).",
};

// Thanks to DrLazor for his help with this function (spam-word / homoglyph detection).
const spamWords = new Set([
  "100k",
  "$100k",
  "72hours",
  "crypto",
  "currency",
  "cs:go",
  "discord",
  "earn",
  "earning",
  "exchange",
  "free",
  "market",
  "nitro",
  "onlyfans",
  "subscription",
  "steam",
  "trading",
]);
const spamHints = [
  "3 month",
  "3 months",
  "airdrop",
  "away",
  "bitcoin",
  "gift",
  "hot",
  "pay",
  "sex",
  "web3",
  "whatsapp",
];

const discordDomains = new Set([
  "discord.com",
  "discordapp.com",
  "discord.gg",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "ptb.discord.com",
  "ptb.discordapp.com",
  "canary.discord.com",
  "canary.discordapp.com",
]);

// Homoglyph -> latin-letter table, ported from utils.lua's
// `nonLatinToLatinEquivalent` (used to normalize spam-evasion unicode
// lookalikes before running the spam-word/hint checks).
const nonLatinToLatinPairs: [string, string][] =
[["ꝚƧ","2"],["ꞫȜƷꝪ","3"],["Ƽ","5"],["ȣȢ","8"],["Ꝯ","9"],["ǃ","!"],["ʔɁ","?"],["ꞏ","·"],["ꞌ","'"],["ꝸ","&"],["ꟷ","ー"],["⍺ａ𝐚𝑎𝒂𝒶𝓪𝔞𝕒𝖆𝖺𝗮𝘢𝙖𝚊ɑα𝛂𝛼𝜶𝝰𝞪аàáâãăäåāąа","a"],["ÀÁÂÃÄÅАＡ𝐀𝐴𝑨𝒜𝓐𝔄𝔸𝕬𝖠𝗔𝘈𝘼𝙰Α𝚨𝛢𝜜𝝖𝞐АᎪᗅꓮ𖽀𐊠","A"],["𝐛𝑏𝒃𝒷𝓫𝔟𝕓𝖇𝖻𝗯𝘣𝙗𝚋ƄЬᏏᑲᖯ","b"],["ВвＢℬ𝐁𝐵𝑩𝓑𝔅𝔹𝕭𝖡𝗕𝘉𝘽𝙱ꞴΒ𝚩𝛣𝜝𝝗𝞑ВᏴᗷꓐ𐊂𐊡𐌁вᏼ","B"],["çčċсｃⅽ𝐜𝑐𝒄𝒸𝓬𝔠𝕔𝖈𝖼𝗰𝘤𝙘𝚌ᴄϲⲥсꮯ𐐽","c"],["СҪС🝌𑣲𑣩ＣⅭℂℭ𝐂𝐶𝑪𝒞𝓒𝕮𝖢𝗖𝘊𝘾𝙲ϹⲤСᏟꓚ𐊢𐌂𐐕𐔜","C"],["đⅾⅆ𝐝𝑑𝒅𝒹𝓭𝔡𝕕𝖉𝖽𝗱𝘥𝙙𝚍ԁᏧᑯꓒꝺ","d"],["Ⅾⅅ𝐃𝐷𝑫𝒟𝓓𝔇𝔻𝕯𝖣𝗗𝘋𝘿𝙳Ꭰᗞᗪꓓꭰ","D"],["е́ё́е℮ｅℯⅇ𝐞𝑒𝒆𝓮𝔢𝕖𝖊𝖾𝗲𝘦𝙚𝚎ꬲеҽ⋴ɛεϵ𝛆𝛜𝜀𝜖𝜺𝝐𝝴𝞊𝞮𝟄ⲉєԑꮛ𑣎𐐩ě","e"],["ÈÉÊËЕЁ́ꭼĚ⋿Ｅℰ𝐄𝐸𝑬𝓔𝔈𝔼𝕰𝖤𝗘𝘌𝙀𝙴Ε𝚬𝛦𝜠𝝚𝞔ЕⴹᎬꓰ𑢦𑢮𐊆𝈡ℇԐᏋ𖼭𐐁","E"],["𝐟𝑓𝒇𝒻𝓯𝔣𝕗𝖋𝖿𝗳𝘧𝙛𝚏ꬵꞙſẝք","f"],["ғҒ𝈓ℱ𝐅𝐹𝑭𝓕𝔉𝔽𝕱𝖥𝗙𝘍𝙁𝙵ꞘϜ𝟊ᖴꓝ𑣂𑢢𐊇𐊥𐔥","F"],["ǵǧｇℊ𝐠𝑔𝒈𝓰𝔤𝕘𝖌𝗀𝗴𝘨𝙜𝚐ɡᶃƍց","g"],["ԍꮐᏻǦ𝐆𝐺𝑮𝒢𝓖𝔊𝔾𝕲𝖦𝗚𝘎𝙂𝙶ԌᏀᏳꓖ","G"],["ꞕｈℎ𝐡𝒉𝒽𝓱𝔥𝕙𝖍𝗁𝗵𝘩𝙝𝚑һհᏂ","h"],["ңҢНнԊнꮋＨℋℌℍ𝐇𝐻𝑯𝓗𝕳𝖧𝗛𝘏𝙃𝙷Η𝚮𝛨𝜢𝝜𝞖ⲎНᎻᕼꓧ𐋏","H"],["ǐ˛⍳ｉⅰℹⅈ𝐢𝑖𝒊𝒾𝓲𝔦𝕚𝖎𝗂𝗶𝘪𝙞𝚒ı𝚤ɪɩιιͺ𝛊𝜄𝜾𝝸𝞲іꙇӏꭵᎥ𑣃","i"],["ǏΙ𝚰𝛪𝜤𝝞𝞘ⲒІӀ𝙸","I"],["ｊⅉ𝐣𝑗𝒋𝒿𝓳𝔧𝕛𝖏𝗃𝗷𝘫𝙟𝚓ϳј","j"],["ꭻ𝚥յＪ𝐉𝐽𝑱𝒥𝓙𝔍𝕁𝕵𝖩𝗝𝘑𝙅𝙹ꞲͿЈᎫᒍꓙ","J"],["𝐤𝑘𝒌𝓀𝓴𝔨𝕜𝖐𝗄𝗸𝘬𝙠𝚔","k"],["ЌҞҚКᴋќҟқкκϰ𝛋𝛞𝜅𝜘𝜿𝝒𝝹𝞌𝞳𝟆ⲕкꮶKＫ𝐊𝐾𝑲𝒦𝓚𝔎𝕂𝕶𝖪𝗞𝘒𝙆𝙺Κ𝚱𝛫𝜥𝝟𝞙ⲔКᏦᛕꓗ𐔘","K"],["׀|∣⏽￨1١۱𐌠𞣇𝟏𝟙𝟣𝟭𝟷🯱ＩⅠℐℑ𝐈𝐼𝑰𝓘𝕀𝕴𝖨𝗜𝘐𝙄Ɩｌⅼℓ𝐥𝑙𝒍𝓁𝓵𝔩𝕝𝖑𝗅𝗹𝘭𝙡𝚕ǀⵏᛁꓲ𖼨𐊊𐌉","l"],["ⳑꮮ𐑃𝈪Ⅼℒ𝐋𝐿𝑳𝓛𝔏𝕃𝕷𝖫𝗟𝘓𝙇𝙻ⳐᏞᒪꓡ𖼖𑢣𑢲𐐛𐔦","L"],["ＭмМⅯℳ𝐌𝑀𝑴𝓜𝔐𝕄𝕸𝖬𝗠𝘔𝙈𝙼Μ𝚳𝛭𝜧𝝡𝞛ϺⲘМᎷᗰᛖꓟ𐊰𐌑","M"],["ʍᴍмꮇṃꭑ","m"],["ñŉɲņ𝐧𝑛𝒏𝓃𝓷𝔫𝕟𝖓𝗇𝗻𝘯𝙣𝚗ոռ","n"],["ͷи𐑍Ｎℕ𝐍𝑁𝑵𝒩𝓝𝔑𝕹𝖭𝗡𝘕𝙉𝙽Ν𝚴𝛮𝜨𝝢𝞜Ⲛꓠ𐔓","N"],["óòôőо́о̑o҅o҆оǒంಂംං०੦૦௦౦೦൦๐໐၀٥۵ｏℴ𝐨𝑜𝒐𝓸𝔬𝕠𝖔𝗈𝗼𝘰𝙤𝚘ᴏᴑꬽο𝛐𝜊𝝄𝝾𝞸σ𝛔𝜎𝝈𝞂𝞼ⲟоჿօഠဝ𐓪𑣈𑣗𐐬","o"],["ОÒÔÖО́ОŐǑŎÖ0߀০୦〇𑓐𑣠𝟎𝟘𝟢𝟬𝟶🯰Ｏ𝐎𝑂𝑶𝒪𝓞𝔒𝕆𝕺𝖮𝗢𝘖𝙊𝙾Ο𝚶𝛰𝜪𝝤𝞞ⲞОՕⵔዐଠ𐓂ꓳ𑢵𐊒𐊫𐐄𐔖","O"],["р́ҏр̌р⍴ｐ𝐩𝑝𝒑𝓅𝓹𝔭𝕡𝖕𝗉𝗽𝘱𝙥𝚙ρϱ𝛒𝛠𝜌𝜚𝝆𝝔𝞀𝞎𝞺𝟈ⲣр","p"],["Р́ҎР̌РᴩꮲＰℙ𝐏𝑃𝑷𝒫𝓟𝔓𝕻𝖯𝗣𝘗𝙋𝙿Ρ𝚸𝛲𝜬𝝦𝞠ⲢРᏢᑭꓑ𐊕","P"],["ɋᶐ𝐪𝑞𝒒𝓆𝓺𝔮𝕢𝖖𝗊𝗾𝘲𝙦𝚚ԛգզ","q"],["ℚ𝐐𝑄𝑸𝒬𝓠𝔔𝕼𝖰𝗤𝘘𝙌𝚀ⵕ","Q"],["𝐫𝑟𝒓𝓇𝓻𝔯𝕣𝖗𝗋𝗿𝘳𝙧𝚛ꭇꭈᴦⲅгꮁ","r"],["яᴙꭱʀꮢ𝈖ℛℜℝ𝐑𝑅𝑹𝓡𝕽𝖱𝗥𝘙𝙍𝚁ƦᎡᏒ𐒴ᖇꓣ𖼵","R"],["ѕｓ𝐬𝑠𝒔𝓈𝓼𝔰𝕤𝖘𝗌𝘀𝘴𝙨𝚜ꜱƽѕꮪ𑣁𐑈","s"],["ЅＳ𝐒𝑆𝑺𝒮𝓢𝔖𝕊𝕾𝖲𝗦𝘚𝙎𝚂ЅՏᏕᏚꓢ𖼺𐊖𐐠","S"],["ţțƫᎿ𝐭𝑡𝒕𝓉𝓽𝔱𝕥𝖙𝗍𝘁𝘵𝙩𝚝","t"],["ТҬҭТтᴛτ𝛕𝜏𝝉𝞃𝞽тꭲȚŢ⊤⟙🝨Ｔ𝐓𝑇𝑻𝒯𝓣𝔗𝕋𝕿𝖳𝗧𝘛𝙏𝚃Τ𝚻𝛵𝜯𝝩𝞣ⲦТᎢꓔ𖼊𑢼𐊗𐊱𐌕","T"],["ùŭǔ𝐮𝑢𝒖𝓊𝓾𝔲𝕦𝖚𝗎𝘂𝘶𝙪𝚞ꞟᴜꭎꭒʋυ𝛖𝜐𝝊𝞄𝞾ս𐓶𑣘","u"],["ŬǓ∪⋃𝐔𝑈𝑼𝒰𝓤𝔘𝕌𝖀𝖴𝗨𝘜𝙐𝚄Սሀ𐓎ᑌꓴ𖽂𑢸","U"],["∨⋁ｖⅴ𝐯𝑣𝒗𝓋𝓿𝔳𝕧𝖛𝗏𝘃𝘷𝙫𝚟ᴠν𝛎𝜈𝝂𝝼𝞶ѵט𑜆ꮩ𑣀","v"],["𝈍٧۷Ⅴ𝐕𝑉𝑽𝒱𝓥𝔙𝕍𝖁𝖵𝗩𝘝𝙑𝚅ѴⴸᏙᐯꛟꓦ𖼈𑢠𐔝","V"],["ɯ𝐰𝑤𝒘𝓌𝔀𝔴𝕨𝖜𝗐𝘄𝘸𝙬𝚠ᴡѡԝա𑜊𑜎𑜏ꮃ","w"],["𑣯𑣦𝐖𝑊𝑾𝒲𝓦𝔚𝕎𝖂𝖶𝗪𝘞𝙒𝚆ԜᎳᏔꓪ","W"],["х᙮×⤫⤬⨯ｘⅹ𝐱𝑥𝒙𝓍𝔁𝔵𝕩𝖝𝗑𝘅𝘹𝙭𝚡хᕁᕽ","x"],["ҲҳХ᙭╳𐌢𑣬ＸⅩ𝐗𝑋𝑿𝒳𝓧𝔛𝕏𝖃𝖷𝗫𝘟𝙓𝚇ꞳΧ𝚾𝛸𝜲𝝬𝞦ⲬХⵝᚷꓫ𐊐𐊴𐌗𐔧","X"],["у́ɣᶌｙ𝐲𝑦𝒚𝓎𝔂𝔶𝕪𝖞𝗒𝘆𝘺𝙮𝚢ʏỿꭚγℽ𝛄𝛾𝜸𝝲𝞬уүყ𑣜","y"],["ұУ́ҰＹ𝐘𝑌𝒀𝒴𝓨𝔜𝕐𝖄𝖸𝗬𝘠𝙔𝚈Υϒ𝚼𝛶𝜰𝝪𝞤ⲨУҮᎩᎽꓬ𖽃𑢤𐊲","Y"],["𝐳𝑧𝒛𝓏𝔃𝔷𝕫𝖟𝗓𝘇𝘻𝙯𝚣ᴢꮓ𑣄","z"],["𐋵𑣥Ｚℤℨ𝐙𝑍𝒁𝒵𝓩𝖅𝖹𝗭𝘡𝙕𝚉Ζ𝚭𝛧𝜡𝝛𝞕Ꮓꓜ𑢩","Z"]];

const nonLatinReplacements: [RegExp, string][] = nonLatinToLatinPairs.map(([chars, repl]) => [
  new RegExp(`[${chars.replace(/[\\\]^-]/g, "\\$&")}]`, "gu"),
  repl,
]);

function removeNonLatinChars(str: string): string {
  let out = str;
  for (const [re, repl] of nonLatinReplacements) out = out.replace(re, repl);
  return out;
}

type RuleOutcome = [boolean | undefined, string | undefined];

export default class RaidModule extends BotModule {
  name = "raid";

  getConfigTable(): ConfigDefinition[] {
    return [
      {
        Array: true,
        Name: "LockAuthorizedRoles",
        Description: "Roles allowed to lock and unlock server",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "AlertChannel",
        Description: "Channel where a message will be posted (if set) in case someone gets muted for spamming",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "LockAlertChannel",
        Description: "Channel where a message will be posted (if set) in case of server locking",
        Type: ConfigType.Channel,
        Optional: true,
      },
      {
        Name: "LockServerVerificationLevel",
        Description: "If server verification level is lower than this, it will be raised for the lock duration",
        Type: ConfigType.Integer,
        Default: GuildVerificationLevel.High,
      },
      {
        Name: "SendMessageThreshold",
        Description: "If a new member sends a message before this duration, they will be auto-banned (0 to disable)",
        Type: ConfigType.Duration,
        Default: 3,
      },
      {
        Name: "DefaultLockDuration",
        Description: "For how many time should the server be locked in case of join spam",
        Type: ConfigType.Duration,
        Default: 10 * 60,
      },
      {
        Name: "JoinCountThreshold",
        Description:
          "How many members are allowed to join the server in the join window before triggering an automatic lock?",
        Type: ConfigType.Integer,
        Default: 10,
      },
      {
        Name: "JoinTimeThreshold",
        Description: "For how long should the join window be open",
        Type: ConfigType.Integer,
        Default: 5,
      },
      {
        Name: "SpamCountThreshold",
        Description:
          'How much "spam score" is allowed in the spam window before the bot bans/mutes the member (1 message = 1 score, but some keywords, links, pings and such increase it)',
        Type: ConfigType.Integer,
        Default: 7,
      },
      {
        Name: "SpamTimeThreshold",
        Description: "For how long should the spam window be open",
        Type: ConfigType.Integer,
        Default: 10,
      },
      {
        Name: "SpamMute",
        Description: "Should the bot mute a member exceeding the spam window instead of banning them? (require the mute module)",
        Type: ConfigType.Boolean,
        Default: true,
      },
      {
        Array: true,
        Name: "SpamImmunity",
        Description: "Roles that will never be auto-banned/muted for spam",
        Type: ConfigType.Role,
        Default: [],
      },
      {
        Name: "JoinWhitelist",
        Description: "List of members allowed to join the server while it's locked",
        Type: ConfigType.User,
        Array: true,
        Default: [],
      },
      {
        Name: "RuleAlertChannel",
        Description: "Channel where a message will be posted (if set) when a rule applies",
        Type: ConfigType.Channel,
        Optional: true,
      },
    ];
  }

  checkLockPermissions(member: GuildMember | null): boolean {
    if (!member) return false;
    const config = this.getConfig(member.guild);
    if (memberHasAnyRole(member, config?.LockAuthorizedRoles)) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return false;
  }

  checkRulePermissions(member: GuildMember | null): boolean {
    return !!member?.permissions.has(PermissionFlagsBits.Administrator);
  }

  async onLoaded(): Promise<boolean> {
    this.registerCommand({
      Name: "lockserver",
      Args: [
        { Name: "duration", Type: ConfigType.Duration, Optional: true, Description: "How long to lock the server for" },
        { Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason for locking the server" },
      ],
      PrivilegeCheck: (member) => this.checkLockPermissions(member),
      Help: "Locks the server, preventing people to join",
      Silent: true,
      Func: async (ctx, duration?: number, reason?: string) => {
        const guild = ctx.guild!;
        const config = this.getConfig(guild)!;
        const lockedBy = ctx.member!;

        if (this.isServerLocked(guild)) {
          await ctx.reply("The server is already locked");
          return;
        }

        if (duration === undefined || duration === null) {
          duration = config.DefaultLockDuration;
        }

        const reasonStart = `locked by ${lockedBy.toString()}`;
        reason = reason ? `${reasonStart}: ${reason}` : reasonStart;

        await this.lockServer(guild, duration!, reason);
      },
    });

    this.registerCommand({
      Name: "unlockserver",
      Args: [{ Name: "reason", Type: ConfigType.String, Optional: true, Description: "Reason for unlocking the server" }],
      PrivilegeCheck: (member) => this.checkLockPermissions(member),
      Help: "Unlocks the server",
      Silent: true,
      Func: async (ctx, reason?: string) => {
        const guild = ctx.guild!;
        const lockedBy = ctx.member!;

        if (!this.isServerLocked(guild)) {
          await ctx.reply("The server is not locked");
          return;
        }

        const reasonStart = `unlocked by ${lockedBy.toString()}`;
        reason = reason ? `${reasonStart}: ${reason}` : reasonStart;

        await this.unlockServer(guild, reason);
      },
    });

    this.registerCommand({
      Name: "rulehelp",
      Args: [],
      PrivilegeCheck: (member) => this.checkRulePermissions(member),
      Help: "List the differents available rules",
      Silent: true,
      Func: async (ctx) => {
        const fields = Object.keys(rules)
          .sort()
          .map((ruleName) => ({
            name: ruleName,
            value: `**Description:** ${rules[ruleName].description}\n**Parameter:** ${rules[ruleName].parameters}`,
          }));

        const effectDescription = Object.keys(effects)
          .sort()
          .map((name) => ` - **${name}**: ${effects[name]}`)
          .join("\n");

        await ctx.reply({
          embeds: [
            {
              title: "Available raid rule list",
              description: `Here's a list of the available rules for the raid module.\n\nUse them with \`!addrule <effect> <rule> <param>\`.\n\nEffect lists:\n${effectDescription}`,
              fields,
            },
          ],
        });
      },
    });

    this.registerCommand({
      Name: "addrule",
      Args: [
        { Name: "effect", Type: ConfigType.String, Description: "authorize, ban or kick" },
        { Name: "rule", Type: ConfigType.String, Description: "Rule name (see !rulehelp)" },
        { Name: "param", Type: ConfigType.String, Description: "Rule parameter" },
      ],
      PrivilegeCheck: (member) => this.checkRulePermissions(member),
      Help: "Adds a new rule for incoming members",
      Func: async (ctx, effect: string, ruleName: string, param: string) => {
        const guild = ctx.guild!;
        const persistentData = this.getPersistentData(guild)!;
        persistentData.rules = persistentData.rules ?? [];

        if (!effects[effect]) {
          const effectList = Object.keys(effects).sort();
          await ctx.reply(`Invalid effect (possible values are ${effectList.join(", ")})`);
          return;
        }

        const rule = rules[ruleName];
        if (!rule) {
          await ctx.reply("Invalid rule (use `!rulehelp` to see valid rules)");
          return;
        }

        const [ruleConfig, err] = rule.parse(param);
        if (!ruleConfig) {
          await ctx.reply(`Invalid rule parameters: ${err}`);
          return;
        }

        persistentData.rules.push({ effect, rule: ruleName, ruleConfig });
        await this.savePersistentData(guild);

        await ctx.reply(`Rule has been added as rule #${persistentData.rules.length}`);
      },
    });

    this.registerCommand({
      Name: "clearrules",
      Args: [],
      PrivilegeCheck: (member) => this.checkRulePermissions(member),
      Help: "Clear all raid rules",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const persistentData = this.getPersistentData(guild)!;
        persistentData.rules = [];
        await this.savePersistentData(guild);

        await ctx.reply("Rules have been cleared");
      },
    });

    this.registerCommand({
      Name: "delrule",
      Args: [{ Name: "ruleIndex", Type: ConfigType.Number, Description: "Rule index (see !listrules)" }],
      PrivilegeCheck: (member) => this.checkRulePermissions(member),
      Help: "Removes a rule by its index",
      Func: async (ctx, ruleIndex: number) => {
        const guild = ctx.guild!;
        const persistentData = this.getPersistentData(guild)!;
        const list: any[] = persistentData.rules ?? [];

        if (ruleIndex < 1 || ruleIndex > list.length) {
          await ctx.reply("Rule index out of range");
          return;
        }
        list.splice(ruleIndex - 1, 1);

        await this.savePersistentData(guild);

        await ctx.reply(`Rule #${ruleIndex} has been removed`);
      },
    });

    this.registerCommand({
      Name: "listrules",
      Args: [],
      PrivilegeCheck: (member) => this.checkRulePermissions(member),
      Help: "List current raid rules",
      Func: async (ctx) => {
        const guild = ctx.guild!;
        const persistentData = this.getPersistentData(guild)!;
        const list: any[] = persistentData.rules ?? [];

        const fields = list.map((ruleData, index) => {
          const rule = rules[ruleData.rule];
          const configStr = rule ? rule.toString(ruleData.ruleConfig) : "<unknown rule>";
          return {
            name: `Rule #${index + 1}`,
            value: `**Rule:** ${ruleData.rule}**\nRule config: ${configStr}**\n**Effect:** ${ruleData.effect}`,
          };
        });

        await ctx.reply({
          embeds: [{ title: "Guild current rules", fields }],
        });
      },
    });

    return true;
  }

  async onEnable(guild: Guild): Promise<boolean> {
    const data = this.getData(guild)!;
    const persistentData = this.getPersistentData(guild)!;
    persistentData.lockedUntil = persistentData.lockedUntil ?? 0;
    persistentData.rules = persistentData.rules ?? [];

    const now = osTime();
    if (persistentData.lockedUntil > now) {
      this.startLockTimer(guild, persistentData.lockedUntil);
      data.locked = true;
    } else {
      data.locked = false;
    }

    data.joinChain = [];
    data.spamChain = {};

    return true;
  }

  async onDisable(guild: Guild): Promise<void> {
    const data = this.getData(guild)!;

    if (data.lockTimer) {
      data.lockTimer.stop();
      data.lockTimer = undefined;
    }

    data.joinChain = [];
  }

  async autoLockServer(guild: Guild, reason: string): Promise<void> {
    const config = this.getConfig(guild)!;
    const duration = config.DefaultLockDuration;
    await this.lockServer(guild, duration, reason);
  }

  startLockTimer(guild: Guild, unlockTimestamp: number): void {
    const data = this.getData(guild)!;

    if (unlockTimestamp < INFINITE_LOCK) {
      const guildId = guild.id;
      data.lockTimer = this.bot.scheduleTimer(unlockTimestamp, async () => {
        const g = this.bot.client.guilds.cache.get(guildId);
        if (g) {
          const persistentData = this.getPersistentData(g)!;
          if (osTime() >= persistentData.lockedUntil) {
            await this.unlockServer(g, "lock duration expired");
          }
        }
      });
    } else {
      data.lockTimer = undefined;
    }
  }

  async lockServer(guild: Guild, duration: number, reason: string): Promise<void> {
    const config = this.getConfig(guild)!;
    const data = this.getData(guild)!;
    const persistentData = this.getPersistentData(guild)!;

    data.locked = true;
    persistentData.lockedUntil = duration > 0 ? osTime() + duration : INFINITE_LOCK;

    const desiredVerificationLevel = clamp(
      config.LockServerVerificationLevel,
      GuildVerificationLevel.None,
      GuildVerificationLevel.VeryHigh,
    );

    const currentVerificationLevel = guild.verificationLevel;
    persistentData.previousVerificationLevel = undefined;
    if (desiredVerificationLevel > currentVerificationLevel) {
      try {
        await guild.setVerificationLevel(desiredVerificationLevel);
        persistentData.previousVerificationLevel = currentVerificationLevel;
      } catch (err: any) {
        this.logWarning(guild, "Failed to raise guild verification level: %s", err?.message ?? err);
      }
    }

    this.startLockTimer(guild, persistentData.lockedUntil);

    if (config.LockAlertChannel) {
      const durationStr = duration > 0 ? discordRelativeTime(duration) : "";

      const alertChannel = guild.channels.cache.get(config.LockAlertChannel);
      if (alertChannel && alertChannel.isTextBased()) {
        await (alertChannel as any)
          .send({
            embeds: [
              {
                color: 16711680,
                description: `🔒 The server has been locked and will be unlocked ${durationStr} (${reason})`,
                timestamp: new Date().toISOString(),
              },
            ],
          })
          .catch(() => {});
      }
    }
  }

  isServerLocked(guild: Guild): boolean {
    return !!this.getData(guild)?.locked;
  }

  async unlockServer(guild: Guild, reason: string): Promise<void> {
    const config = this.getConfig(guild)!;
    const data = this.getData(guild)!;
    const persistentData = this.getPersistentData(guild)!;

    if (data.locked) {
      data.locked = false;

      if (persistentData.previousVerificationLevel !== undefined && persistentData.previousVerificationLevel !== null) {
        try {
          await guild.setVerificationLevel(persistentData.previousVerificationLevel);
        } catch (err: any) {
          this.logWarning(guild, "Failed to reset guild verification level: %s", err?.message ?? err);
        }
      }

      if (config.LockAlertChannel) {
        const alertChannel = guild.channels.cache.get(config.LockAlertChannel);
        if (alertChannel && alertChannel.isTextBased()) {
          await (alertChannel as any)
            .send({
              embeds: [
                {
                  color: 65280,
                  description: `🔓 The server has been unlocked (${reason})`,
                  timestamp: new Date().toISOString(),
                },
              ],
            })
            .catch(() => {});
        }
      }
    }
  }

  async handleRules(member: GuildMember): Promise<RuleOutcome> {
    const guild = member.guild;
    const config = this.getConfig(guild)!;

    const whitelist: string[] = config.JoinWhitelist ?? [];
    if (whitelist.includes(member.id)) {
      return [true, `${member.toString()} has been allowed to join (whitelisted)`];
    }

    const persistentData = this.getPersistentData(guild)!;
    const ruleList: any[] = persistentData.rules ?? [];

    let i = 0;
    for (const ruleData of ruleList) {
      i++;
      const rule = rules[ruleData.rule];
      if (!rule) continue; // defensive: unknown/removed rule name
      if (rule.check(member, ruleData.ruleConfig)) {
        const ruleStr = `rule ${i} - ${ruleData.rule}(${rule.toString(ruleData.ruleConfig)})`;

        if (ruleData.effect === "authorize") {
          return [true, `${member.toString()} has been allowed to join due to ${ruleStr}`];
        } else if (ruleData.effect === "ban") {
          await member.ban({ reason: `auto-ban due to ${ruleStr}`, deleteMessageSeconds: 0 }).catch(() => {});
          return [false, `${member.toString()} has been banned due to ${ruleStr}`];
        } else if (ruleData.effect === "kick") {
          await member.kick(`auto-kick due to ${ruleStr}`).catch(() => {});
          return [false, `${member.toString()} has been kicked due to ${ruleStr}`];
        }
      }
    }

    return [undefined, undefined];
  }

  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const config = this.getConfig(guild)!;
    const data = this.getData(guild)!;

    const [allowed, msg] = await this.handleRules(member);
    if (allowed) {
      if (msg && data.locked) {
        const ruleAlertChannel = config.RuleAlertChannel ? guild.channels.cache.get(config.RuleAlertChannel) : undefined;
        if (ruleAlertChannel && ruleAlertChannel.isTextBased()) {
          await (ruleAlertChannel as any).send(msg).catch(() => {});
        }
      }
      return; // no more check
    } else if (allowed === false) {
      if (msg) {
        const ruleAlertChannel = config.RuleAlertChannel ? guild.channels.cache.get(config.RuleAlertChannel) : undefined;
        if (ruleAlertChannel && ruleAlertChannel.isTextBased()) {
          await (ruleAlertChannel as any).send(msg).catch(() => {});
        }
      }
      return;
    }

    if (data.locked) {
      await member.kick("server is locked").catch(() => {});
    } else {
      const now = osTime();

      const joinCountThreshold = config.JoinCountThreshold;
      const timeThreshold = config.JoinTimeThreshold;

      while (data.joinChain.length > 0 && now - data.joinChain[0].at > timeThreshold) {
        data.joinChain.shift();
      }

      data.joinChain.push({ at: now, memberId: member.id });

      if (data.joinChain.length > joinCountThreshold) {
        await this.autoLockServer(guild, "auto-lock by anti-raid system");

        const membersToKick: string[] = data.joinChain.map((j: any) => j.memberId);

        for (const memberId of membersToKick) {
          const m = guild.members.cache.get(memberId);
          if (m) {
            await m.kick("server is locked").catch(() => {});
          }
        }
      }
    }
  }

  computeMessageSpamScore(content: string): number {
    let score = 1; // base score

    for (const token of content.split(/\s+/)) {
      if (token && spamWords.has(token)) score += 1;
    }

    for (const hint of spamHints) {
      if (content.includes(hint)) {
        score += 1;
        break;
      }
    }

    const uniquePings = new Set<string>();
    for (const m of content.matchAll(/<@!?(\d+)>/g)) {
      const ping = m[1];
      if (!uniquePings.has(ping)) {
        score += 1;
        uniquePings.add(ping);
      }
    }

    if (content.includes("@everyone") || content.includes("@here") || /<@&\d+>/.test(content)) {
      score *= 2;
    }

    for (const m of content.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      const domain = m[1];
      if (!discordDomains.has(domain)) {
        score *= 2;
        break;
      }
    }

    return score;
  }

  async onMessageCreate(message: Message): Promise<void> {
    if (!this.bot.isPublicChannel(message.channel as any)) return;
    if (message.author.bot) return;

    const guild = message.guild;
    const member = message.member;
    if (!guild || !member) return;

    const data = this.getData(guild)!;
    const config = this.getConfig(guild)!;

    // Check if message happens right after joining
    if (message.type !== MessageType.UserJoin) {
      const joinedTimestamp = member.joinedTimestamp;
      const secondsSinceJoin = joinedTimestamp !== null ? (Date.now() - joinedTimestamp) / 1000 : Infinity;
      if (secondsSinceJoin < config.SendMessageThreshold) {
        try {
          await member.ban({ reason: "auto-ban for bot suspicion", deleteMessageSeconds: 86400 });
        } catch (err: any) {
          this.logWarning(guild, "Failed to autoban potential bot %s (%s)", member.user.tag, err?.message ?? err);
        }
        return;
      }
    }

    // Check immunity
    if (memberHasAnyRole(member, config.SpamImmunity)) return;

    // Remember previous messages and try to identify spam
    let spamChain: any[] = data.spamChain[member.id];
    if (!spamChain) {
      spamChain = [];
      data.spamChain[member.id] = spamChain;
    }

    const now = osTime();
    const countThreshold = config.SpamCountThreshold;
    const timeThreshold = config.SpamTimeThreshold;

    // Remove messages outside spam window
    while (spamChain.length > 0 && now - spamChain[0].at > timeThreshold) {
      spamChain.shift();
    }

    // Compute message score and remember it
    const lowerContent = removeNonLatinChars(message.content).toLowerCase();
    const score = this.computeMessageSpamScore(lowerContent);

    spamChain.push({
      at: now,
      channelId: message.channel.id,
      content: lowerContent,
      realContent: message.content,
      messageId: message.id,
      score,
    });

    // NOTE(port): preserved verbatim from the Lua source. `lastChannel` starts
    // `undefined` and is only ever assigned *inside* the branch that requires
    // it to already be truthy, so the "channel switch" score bonus below can
    // never actually trigger. This looks like a bug upstream, but is kept
    // as-is for behavioral fidelity.
    let lastChannel: string | undefined;
    const seenContent: Record<string, number> = {};
    let totalScore = 0;
    for (const spam of spamChain) {
      if (lastChannel && lastChannel !== spam.channelId) {
        totalScore += 1;
        lastChannel = spam.channelId;
      }

      const seenScore = seenContent[spam.content];
      if (seenScore) {
        totalScore += seenScore;
        seenContent[spam.content] = seenScore + 1;
      } else {
        seenContent[spam.content] = 1;
      }

      totalScore += spam.score;
    }

    if (totalScore > countThreshold) {
      if (config.SpamMute) {
        const muteModule = this.bot.getModuleForGuild(guild, "mute") as any;
        let muteSuccess = false;
        let muteErr: string | undefined = "mute module not available";
        if (muteModule && typeof muteModule.mute === "function") {
          try {
            const result = await muteModule.mute(guild, member.id, 0);
            if (Array.isArray(result)) {
              [muteSuccess, muteErr] = result;
            } else {
              muteSuccess = !!result;
              muteErr = undefined;
            }
          } catch (e: any) {
            muteSuccess = false;
            muteErr = e?.message ?? String(e);
          }
        }

        if (muteSuccess) {
          // Send an alert
          const alertChannel = config.AlertChannel ? guild.channels.cache.get(config.AlertChannel) : undefined;
          if (alertChannel && alertChannel.isTextBased()) {
            const channelList = spamChain.map((spam) => {
              const channel = guild.channels.cache.get(spam.channelId);
              return channel ? channel.toString() : "#deleted_channel";
            });

            const fields = spamChain.map((spam) => {
              let value = String(spam.realContent).slice(0, 1000); // This is limited to 1024 chars
              if (value.length !== String(spam.realContent).length) {
                value += "... (truncated)";
              }
              return { name: "Message", value };
            });

            await (alertChannel as any)
              .send({
                embeds: [
                  {
                    color: 16776960,
                    description: `🙊 ${member.toString()} has been auto-muted because of spam in ${channelList.join(", ")}`,
                    fields,
                    timestamp: new Date().toISOString(),
                  },
                ],
              })
              .catch(() => {});
          }

          // Delete messages
          const messagesToDelete = [...spamChain];
          delete data.spamChain[member.id];

          for (const messageData of messagesToDelete) {
            const channel = guild.channels.cache.get(messageData.channelId);
            if (channel && channel.isTextBased()) {
              const msg = await (channel as any).messages.fetch(messageData.messageId).catch(() => undefined);
              if (msg) await msg.delete().catch(() => {});
            }
          }
        } else {
          this.logWarning(guild, "Failed to mute potential bot %s: %s", member.user.tag, muteErr);
        }
      } else {
        try {
          await member.ban({ reason: "auto-ban for bot suspicion", deleteMessageSeconds: 86400 });
        } catch (err: any) {
          this.logWarning(guild, "Failed to autoban potential bot %s (%s)", member.user.tag, err?.message ?? err);
        }
      }
    }
  }
}

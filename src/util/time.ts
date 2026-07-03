// Ported from utils.lua time helpers (FormatTime, ConvertToTime, DiscordTime...).

interface TimeUnit {
  altNames: string[];
  nameSingular: string;
  namePlural: string;
  seconds: number;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
const CENTURY = 100 * YEAR;
const MILLENNIUM = 10 * CENTURY;

export const timeUnits: TimeUnit[] = [
  { altNames: ["u"], nameSingular: "age of the Universe", namePlural: "ages of the Universe", seconds: 13800000 * MILLENNIUM },
  { altNames: ["mi"], nameSingular: "millennium", namePlural: "millennia", seconds: MILLENNIUM },
  { altNames: ["c"], nameSingular: "century", namePlural: "centuries", seconds: CENTURY },
  { altNames: ["y"], nameSingular: "year", namePlural: "years", seconds: YEAR },
  { altNames: ["M"], nameSingular: "month", namePlural: "months", seconds: MONTH },
  { altNames: ["w"], nameSingular: "week", namePlural: "weeks", seconds: WEEK },
  { altNames: ["d"], nameSingular: "day", namePlural: "days", seconds: DAY },
  { altNames: ["h"], nameSingular: "hour", namePlural: "hours", seconds: HOUR },
  { altNames: ["m", "min"], nameSingular: "minute", namePlural: "minutes", seconds: MINUTE },
  { altNames: ["s", "sec"], nameSingular: "second", namePlural: "seconds", seconds: 1 },
];

const timeUnitByUnit: Record<string, TimeUnit> = {};
for (const unit of timeUnits) {
  const register = (name: string) => {
    if (timeUnitByUnit[name] !== undefined) throw new Error(`TimeUnit name ${name} already registered`);
    timeUnitByUnit[name] = unit;
  };
  register(unit.nameSingular);
  register(unit.namePlural);
  for (const alt of unit.altNames) register(alt);
}

/** "and"-joins a list: `["a","b","c"]` -> `"a, b and c"`. */
export function niceConcat(tab: string[]): string {
  if (tab.length > 1) return tab.slice(0, -1).join(", ") + " and " + tab[tab.length - 1];
  if (tab.length === 1) return tab[0];
  return "";
}

/** Parse "1h30m", "90 minutes", "3600" into a number of seconds. Returns undefined on failure. */
export function convertToTime(str: string): number | undefined {
  const asNumber = Number(str);
  if (!Number.isNaN(asNumber) && str.trim() !== "") return asNumber;

  let seconds = 0;
  let isValid = false;
  const re = /([\d-]+)\s*([a-zA-Z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const value = Number(m[1]);
    if (Number.isNaN(value)) return undefined;
    const unit = timeUnitByUnit[m[2]];
    if (!unit) return undefined;
    isValid = true;
    seconds += value * unit.seconds;
  }
  return isValid ? seconds : undefined;
}

/** Turn a number of seconds into "2 hours and one minute". `depth` limits units shown. */
export function formatTime(seconds: number, depth = 0): string {
  if (typeof seconds !== "number") return String(seconds);
  if (seconds < timeUnits[timeUnits.length - 1].seconds) {
    return "zero " + timeUnits[timeUnits.length - 1].nameSingular;
  }

  const txt: string[] = [];
  for (const unit of timeUnits) {
    if (seconds >= unit.seconds) {
      const count = Math.floor(seconds / unit.seconds);
      seconds -= count * unit.seconds;
      txt.push(count > 1 ? `${count} ${unit.namePlural}` : `one ${unit.nameSingular}`);
      if (depth > 0) {
        depth -= 1;
        if (depth < 1) break;
      }
    }
  }
  return niceConcat(txt);
}

const DISCORD_MAX_TIMESTAMP = 4294962947295;

export function discordTime(timestamp: number): string {
  return timestamp < DISCORD_MAX_TIMESTAMP ? `<t:${timestamp}>` : formatTime(timestamp, 3);
}

export function discordRelativeTimestamp(timestamp: number): string {
  if (timestamp < DISCORD_MAX_TIMESTAMP) return `<t:${timestamp}:R>`;
  const now = Math.floor(Date.now() / 1000);
  return timestamp > now ? "in " + formatTime(timestamp - now, 3) : formatTime(now - timestamp, 3) + " ago";
}

export function discordRelativeTime(duration: number): string {
  return discordRelativeTimestamp(Math.floor(Date.now() / 1000) + duration);
}

/** Current unix time in seconds (Lua's os.time equivalent used throughout the bot). */
export function osTime(): number {
  return Math.floor(Date.now() / 1000);
}

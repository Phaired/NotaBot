// Minimal leveled logger mirroring discordia client:info/warning/error.

function stamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(fmt: string, ...args: any[]) {
    console.log(`[${stamp()}][INFO] ${format(fmt, args)}`);
  },
  warning(fmt: string, ...args: any[]) {
    console.warn(`[${stamp()}][WARN] ${format(fmt, args)}`);
  },
  error(fmt: string, ...args: any[]) {
    console.error(`[${stamp()}][ERROR] ${format(fmt, args)}`);
  },
};

// Lua uses printf-style %s/%d formatting extensively; emulate the common cases so
// ported call sites (`logInfo("Loaded %s (%.3fs)", name, t)`) keep working.
function format(fmt: string, args: any[]): string {
  if (args.length === 0) return fmt;
  let i = 0;
  return fmt.replace(/%(\.\d+)?[sdfq%]/g, (match) => {
    if (match === "%%") return "%";
    const arg = args[i++];
    if (/f$/.test(match)) {
      const prec = match.match(/\.(\d+)/);
      return Number(arg).toFixed(prec ? Number(prec[1]) : 6);
    }
    return String(arg);
  });
}

export { format as sprintf };

// Converts the original 774KB `data_emoji.lua` table into `data/emoji.json`
// (the format src/core/emoji.ts loads: [{ names: string[], codes: string[] }]).
//
//   pnpm tsx src/scripts/convertEmoji.ts [path/to/data_emoji.lua] [out.json]
//
// The Lua entries look like:
//   ["100"] = { names = { "100" }, codes = { "\xF0\x9F\x92\xAF" } },

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const input = process.argv[2] ?? join(__dirname, "..", "..", "..", "data_emoji.lua");
const output = process.argv[3] ?? join(__dirname, "..", "..", "data", "emoji.json");

/** Decode a Lua string literal body (with \xNN escapes) into a JS string. */
function decodeLua(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "x") {
      bytes.push(parseInt(body.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (body[i] === "\\" && body[i + 1] === "u") {
      // \u{XXXX}
      const m = body.slice(i).match(/^\\u\{([0-9a-fA-F]+)\}/);
      if (m) {
        for (const b of Buffer.from(String.fromCodePoint(parseInt(m[1], 16)), "utf8")) bytes.push(b);
        i += m[0].length - 1;
      }
    } else {
      for (const b of Buffer.from(body[i], "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function main() {
  const text = readFileSync(input, "utf8");
  const lines = text.split(/\r?\n/);

  const entries: { names: string[]; codes: string[] }[] = [];
  let current: { names: string[]; codes: string[] } | null = null;
  let section: "names" | "codes" | null = null;

  for (const line of lines) {
    if (/^\s*\[".*?"\]\s*=\s*\{/.test(line)) {
      current = { names: [], codes: [] };
      entries.push(current);
      section = null;
      continue;
    }
    if (/\bnames\s*=\s*\{/.test(line)) { section = "names"; continue; }
    if (/\bcodes\s*=\s*\{/.test(line)) { section = "codes"; continue; }
    if (/^\s*\}/.test(line)) { section = null; continue; }

    if (current && section) {
      // capture the first quoted string on the line (ignore trailing comments)
      const m = line.match(/"((?:[^"\\]|\\.)*)"/);
      if (m) {
        const value = section === "codes" ? decodeLua(m[1]) : m[1];
        current[section].push(value);
      }
    }
  }

  const usable = entries.filter((e) => e.names.length && e.codes.length);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(usable), "utf8");
  console.log(`Wrote ${usable.length} emoji to ${output}`);
}

main();

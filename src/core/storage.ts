// JSON persistence layer, replacing bot_utility.lua Serialize/UnserializeToFile.
// All module data lives under ./data, same layout as the Lua bot:
//   data/module_<name>/global_config.json
//   data/module_<name>/global_data.json
//   data/module_<name>/guild_<id>/config.json
//   data/module_<name>/guild_<id>/persistentdata.json

import { promises as fs } from "fs";
import * as path from "path";

export async function serializeToFile(filepath: string, data: unknown, pretty = false): Promise<[boolean, string?]> {
  try {
    const dir = path.dirname(filepath);
    if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true });
    const json = JSON.stringify(data, null, pretty ? "\t" : undefined);
    await fs.writeFile(filepath, json, "utf8");
    return [true];
  } catch (err: any) {
    return [false, `Failed to write ${filepath}: ${err?.message ?? err}`];
  }
}

export async function unserializeFromFile<T = any>(filepath: string): Promise<[T | undefined, string?]> {
  try {
    const content = await fs.readFile(filepath, "utf8");
    return [JSON.parse(content) as T];
  } catch (err: any) {
    return [undefined, `Failed to read ${filepath}: ${err?.message ?? err}`];
  }
}

/** Synchronous directory listing helper used when loading a module's data on boot. */
export async function scanDir(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

// The Desk's data: one JSON file per project in data/projects/. The server and the `desk` command
// both write them, so every change is read-modify-write under a short lock and lands atomically.
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = process.env.DESK_DATA || join(ROOT, "data", "projects");
export const HOME = homedir();
export const expand = (p) => (p || "").replace(/^~(?=\/|$)/, HOME);
export const tilde = (p) => (p || "").startsWith(HOME) ? "~" + p.slice(HOME.length) : p;

const file = (id) => join(DATA, id + ".json");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function listIds() {
  try { return readdirSync(DATA).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; }
}

export function load(id) {
  return JSON.parse(readFileSync(file(id), "utf8"));
}

export function loadAll() {
  return listIds().map((id) => { try { return load(id); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

function save(p) {
  mkdirSync(DATA, { recursive: true });
  const tmp = file(p.id) + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  renameSync(tmp, file(p.id));
}

// Change one project: fn(project) mutates it and may return a value. A lock directory keeps the
// server and the command from overwriting each other; a lock older than 10s is treated as stale.
export function update(id, fn) {
  const lock = file(id) + ".lock";
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10000) { rmdirSync(lock); continue; } } catch {}
      if (i > 200) throw new Error("The project file is busy. Try again in a moment.");
      sleep(25);
    }
  }
  try {
    const p = load(id);
    const out = fn(p);
    save(p);
    return out;
  } finally { try { rmdirSync(lock); } catch {} }
}

export function create(p) {
  save(p);
}

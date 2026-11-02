// The Desk's data: one JSON file per project in data/projects/. The server and the `desk` command
// both write them, so every change is read-modify-write under a short lock and lands atomically.
// Sales and the Blendd clients live in the shared folder instead (SHARED/projects), a private git
// repo that Diogo's and João's Desks keep in sync (lib/sync.mjs). Ids never repeat across the two.
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, rmdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Where this person's Desk keeps its data (projects, runs, uploads, briefs, transcripts). Diogo's
// own Desk keeps it next to the code; the installed app (app/) gives each person their own folder.
export const DESK_HOME = process.env.DESK_HOME || ROOT;
export const DATA = process.env.DESK_DATA || join(DESK_HOME, "data", "projects");
export const HOME = homedir();
// Whose Desk this is: the app asks on first start and keeps it in config.json.
export const ME = (() => { try { return JSON.parse(readFileSync(join(DESK_HOME, "config.json"), "utf8")).name || "Diogo"; } catch { return "Diogo"; } })();
// The shared folder: outside the code (the code repo is public), never inside it.
export const SHARED = process.env.DESK_SHARED || (DESK_HOME === ROOT ? join(HOME, "Projects", "blendd-desk-shared") : join(DESK_HOME, "shared"));
export const SHARED_DATA = join(SHARED, "projects");
// "shared:<path>" names a file inside the shared folder, the same on both computers.
export const expand = (p) => (p || "").replace(/^shared:/, SHARED + "/").replace(/^~(?=[\\/]|$)/, HOME);
export const tilde = (p) => (p || "").startsWith(HOME) ? "~" + p.slice(HOME.length) : p;

const file = (id) => { const sh = join(SHARED_DATA, id + ".json"); return existsSync(sh) ? sh : join(DATA, id + ".json"); };
const isShared = (id) => existsSync(join(SHARED_DATA, id + ".json"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const idsIn = (d) => { try { return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; } };
export function listIds() { return [...new Set([...idsIn(DATA), ...idsIn(SHARED_DATA)])]; }

// A shared project keeps one folder per person (their computers differ): p.folder is this person's.
export function load(id) {
  const p = JSON.parse(readFileSync(file(id), "utf8"));
  if (isShared(id)) {
    p.shared = true; p.folder = p.folders?.[ME] || "~/Blendd/" + (p.name || id).replace(/[\\/:*?"<>|]/g, "-");
    for (const f of p.files || []) if (f.path) f.path = expand(f.path); // "shared:…" → this computer's path
  }
  return p;
}

export function loadAll() {
  return listIds().map((id) => { try { return load(id); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

function save(p) {
  const shared = p.shared || isShared(p.id), dir = shared ? SHARED_DATA : DATA;
  mkdirSync(dir, { recursive: true });
  let out = p;
  if (shared) {
    const { shared: _s, folder, ...rest } = p;
    out = { ...rest, folders: { ...(p.folders || {}), ...(folder ? { [ME]: folder } : {}) },
      files: (p.files || []).map((f) => (f.path && f.path.startsWith(SHARED + "/") ? { ...f, path: "shared:" + f.path.slice(SHARED.length + 1) } : f)) };
  }
  const target = join(dir, p.id + ".json"), tmp = target + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, target);
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

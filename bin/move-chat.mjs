#!/usr/bin/env node
// Moves a Desk chat to another folder (13 Nov 2026: the UrgentPlumber Call center and Ads chats ran from the home
// folder, so the project's own Claude setup never loaded). Claude Code files a conversation under its folder, so
// the conversation (every earlier id too, with its helpers) is COPIED to the new folder's place first; the old
// copies stay as a backup. Only for a chat that isn't replying.
//   node bin/move-chat.mjs <project> <session id> <new folder>
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { load, expand } from "../lib/store.mjs";
import { run } from "../lib/ops.mjs";
const [pid, sid, to] = process.argv.slice(2);
const p = load(pid), s = p.sessions.find((x) => x.id === sid); if (!s) throw new Error("no such chat");
const slug = (d) => d.replace(/[^a-zA-Z0-9]/g, "-");
const from = join(homedir(), ".claude", "projects", slug(expand(s.cwd))), dest = join(homedir(), ".claude", "projects", slug(expand(to)));
mkdirSync(dest, { recursive: true });
let n = 0;
for (const id of [...(s.previousIds || []), s.id]) for (const f of [id + ".jsonl", id]) if (existsSync(join(from, f))) { cpSync(join(from, f), join(dest, f), { recursive: true }); n++; }
run("session.set", pid, { id: s.id, cwd: expand(to) });
console.log(`${s.name}: ${n} conversation files copied to ${dest}; chat now runs in ${expand(to)}`);

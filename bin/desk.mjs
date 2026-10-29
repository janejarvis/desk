#!/usr/bin/env node
// `desk` — how Claude sessions keep Jane's Desk current. Run `desk help`.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ROOT, HOME, expand, tilde, load, loadAll } from "../lib/store.mjs";
import { run, projectId, trackOf, ownerOf, STATUSES } from "../lib/ops.mjs";

const HELP = `desk — keep Jane's Desk current (roadmap, board, meetings).

Read
  desk status [--project P] [--track T]      roadmap and to-dos with their ids

To-dos (statuses: ${STATUSES.join(", ")})
  desk todo add "<title>" [--track T] [--milestone ID] [--p 1|2|3] [--due YYYY-MM-DD]
                [--status S] [--waiting NAME] [--owner NAME] [--note TEXT]
  desk todo <id> <status> [--why TEXT] [--waiting NAME] [--to NAME] [--note TEXT]
  desk todo set <id> [--title] [--status] [--p] [--due] [--milestone] [--track] [--note] ...
  desk todo remove <id>
    blocked needs --why; waiting takes --waiting <who>; sent takes --to <who>.
  Ongoing duties (never finished, repeat --every daily|weekly|monthly):
  desk todo add "<title>" --status ongoing --every weekly
  desk todo tick <id>                         did it again (e.g. logged today's hours)

Roadmap (milestone status: done, now, next)
  desk milestone add "<title>" [--track T] [--status S] [--due YYYY-MM-DD] [--note TEXT]
  desk milestone <id> <status>
  desk milestone set <id> [--title] [--due] [--status] [--note]

Meetings
  desk meeting done <id> --summary "<text>" --action "<text>" [--action ...]

Tracks and sessions
  desk track add "<name>" · desk track rename <id> "<name>"
  desk join [--project P] [--track T] [--name N]   put this session on the Desk

App
  desk open                                   start the Desk and open it

The project and track default to this session's own (when it's on the Desk); pass --project
and --track otherwise. Names or ids both work.`;

// ---- arguments ----
const argv = process.argv.slice(2);
const pos = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2), v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (k === "action") (flags.action ||= []).push(v); else flags[k] = v;
  } else pos.push(a);
}

// ---- which session is running this command ----
function mySessionId() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const f = join(HOME, ".claude", "sessions", pid + ".json");
    if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")).sessionId; } catch { return null; } }
    try { pid = +execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return null; }
  }
  return null;
}
let mineCache;
function mine() {
  if (mineCache !== undefined) return mineCache;
  const sid = mySessionId();
  for (const p of loadAll()) { const s = p.sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid)); if (s) return (mineCache = { p, s }); }
  return (mineCache = null);
}
// A session on the Desk is walled into its own project: it can't read or change another one,
// so one client's work never leaks into another's (29 Oct 2026, Jane's ruling).
function own() { return process.env.DESK_PROJECT || mine()?.p.id || null; }
function guard(pid) {
  const o = own();
  if (o && pid !== o) fail(`This session works on ${load(o).name}; it can't see or change ${load(pid).name}.`);
  return pid;
}
const owner = (list, id) => guard(ownerOf(list, id));
function project() {
  if (flags.project) return guard(projectId(flags.project));
  if (process.env.DESK_PROJECT) return process.env.DESK_PROJECT;
  if (mine()) return mine().p.id;
  const cwd = process.cwd();
  const hits = loadAll().filter((p) => p.folder !== "~" && (cwd === expand(p.folder) || cwd.startsWith(expand(p.folder) + "/")));
  if (hits.length === 1) return hits[0].id;
  fail(`Which project? Add --project <name> (${loadAll().map((p) => p.name).join(", ")}).`);
}
function track(pid) {
  const p = load(pid);
  if (flags.track) return trackOf(p, flags.track);
  if (process.env.DESK_PROJECT === pid && process.env.DESK_TRACK) return process.env.DESK_TRACK;
  if (mine()?.p.id === pid) return mine().s.track;
  if (p.tracks.length === 1) return p.tracks[0].id;
  fail(`Which track of ${p.name}? Add --track <name> (${p.tracks.map((t) => t.name).join(", ")}).`);
}
function fail(msg) { console.error(msg); process.exit(1); }

const todoFields = () => ({
  title: flags.title, status: flags.status, priority: flags.p ?? flags.priority, due: flags.due, owner: flags.owner,
  note: flags.note, why: flags.why, waitingOn: flags.waiting, sentTo: flags.to, milestone: flags.milestone, every: flags.every,
});
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const say = (msg) => console.log(msg);

// ---- status ----
function status() {
  const pid = project(), p = load(pid);
  const only = flags.track ? trackOf(p, flags.track) : null;
  const label = { ongoing: "Ongoing", todo: "To do", doing: "Doing", blocked: "Blocked", waiting: "Waiting on", sent: "Sent", done: "Done" };
  say(`${p.name}  ·  ${tilde(expand(p.folder))}`);
  for (const t of p.tracks.filter((x) => !only || x.id === only)) {
    say(`\n## ${t.name}  (track id: ${t.id})`);
    const ms = p.milestones.filter((m) => m.track === t.id);
    say(ms.length ? "Roadmap:" : "Roadmap: (no milestones yet)");
    for (const m of ms) say(`  ${m.status === "done" ? "✓" : m.status === "now" ? "◉" : "○"} ${m.title}${m.due ? (m.status === "done" ? "  · " : "  · due ") + m.due : ""}  [${m.id}]`);
    const ts = p.todos.filter((x) => x.track === t.id);
    if (!ts.length) { say("To-dos: (none yet)"); continue; }
    for (const s of STATUSES) {
      const its = ts.filter((x) => x.status === s && (s !== "done" || Date.now() - Date.parse(x.doneAt || x.updatedAt) < 14 * 864e5));
      if (!its.length) continue;
      say(`${label[s]}:`);
      for (const x of its) {
        const extra = [x.priority === 1 ? "P1" : "", x.due ? "due " + x.due : "", x.why ? "why: " + x.why : "", s === "waiting" && x.waitingOn ? "on " + x.waitingOn : "", s === "sent" && x.sentTo ? "to " + x.sentTo : "", s === "ongoing" ? `every ${x.every || "week"}, last done ${x.lastDone ? x.lastDone.slice(0, 10) : "never"}` : "", x.milestone ? "milestone " + x.milestone : ""].filter(Boolean).join(" · ");
        say(`  - ${x.title}${extra ? "  (" + extra + ")" : ""}  [${x.id}]`);
      }
    }
  }
  const newMeetings = p.meetings.filter((m) => m.status === "new");
  if (newMeetings.length) say(`\nMeetings not read yet: ${newMeetings.map((m) => `${m.title} (${m.date}) [${m.id}]`).join(", ")}`);
}

// ---- open ----
async function open() {
  const port = process.env.DESK_PORT || 4848, url = `http://127.0.0.1:${port}`;
  const up = async () => { try { const r = await fetch(url + "/api/state"); return r.ok && Array.isArray((await r.json()).projects); } catch { return false; } }; // the Desk, not another app on the port
  if (!(await up())) {
    const log = openSync(join(ROOT, "desk.log"), "a");
    spawn(process.execPath, [join(ROOT, "server.mjs")], { detached: true, stdio: ["ignore", log, log] }).unref();
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 150));
  }
  try { execFileSync("open", [url]); } catch {}
  say(`Desk: ${url}`);
}

// ---- dispatch ----
const [cmd, a1, a2] = pos;
try {
  if (!cmd || cmd === "help" || flags.help) say(HELP);
  else if (cmd === "status") status();
  else if (cmd === "open") await open();
  else if (cmd === "todo") {
    if (a1 === "add") { const pid = project(); const t = run("todo.add", pid, { ...strip(todoFields()), title: a2, track: track(pid), source: "claude" }); say(`Added [${t.id}] ${t.title} (${t.status})`); }
    else if (a1 === "tick") { const t = run("todo.tick", owner("todos", a2), { id: a2 }); say(`[${t.id}] ${t.title}: done again ${t.lastDone.slice(0, 10)}`); }
    else if (a1 === "remove") { run("todo.remove", owner("todos", a2), { id: a2 }); say("Removed."); }
    else if (a1 === "set") { const pid = owner("todos", a2); const t = run("todo.set", pid, { ...strip(todoFields()), id: a2, track: flags.track }); say(`[${t.id}] ${t.title}: ${t.status}`); }
    else if (a1 && a2 && STATUSES.includes(a2)) { const t = run("todo.set", owner("todos", a1), { ...strip(todoFields()), id: a1, status: a2 }); say(`[${t.id}] ${t.title}: ${t.status}`); }
    else fail("Try: desk todo add \"<title>\" · desk todo <id> <status> · desk help");
  } else if (cmd === "milestone") {
    const f = strip({ title: flags.title, due: flags.due, status: flags.status, note: flags.note });
    if (a1 === "add") { const pid = project(); const m = run("milestone.add", pid, { ...f, title: a2, track: track(pid) }); say(`Added milestone [${m.id}] ${m.title} (${m.status})`); }
    else if (a1 === "remove") { run("milestone.remove", owner("milestones", a2), { id: a2 }); say("Removed."); }
    else if (a1 === "set") { const m = run("milestone.set", owner("milestones", a2), { ...f, id: a2 }); say(`[${m.id}] ${m.title}: ${m.status}`); }
    else if (a1 && a2) { const m = run("milestone.set", owner("milestones", a1), { ...f, id: a1, status: a2 }); say(`[${m.id}] ${m.title}: ${m.status}`); }
    else fail("Try: desk milestone add \"<title>\" · desk milestone <id> <status> · desk help");
  } else if (cmd === "meeting" && a1 === "done") {
    if (!a2 || !flags.summary) fail("Usage: desk meeting done <id> --summary \"...\" --action \"...\"");
    run("meeting.set", owner("meetings", a2), { id: a2, status: "read", summary: flags.summary, actions: flags.action || [] });
    say(`Saved: summary and ${(flags.action || []).length} action(s). Jane picks which go on the board.`);
  } else if (cmd === "track") {
    const pid = project();
    if (a1 === "add") { const t = run("track.add", pid, { name: a2 }); say(`Added track ${t.name} [${t.id}]`); }
    else if (a1 === "rename") { const t = run("track.rename", pid, { id: a2, name: pos[3] }); say(`Track ${t.id} is now ${t.name}`); }
    else fail("Try: desk track add \"<name>\" · desk track rename <id> \"<name>\"");
  } else if (cmd === "join") {
    const sid = mySessionId(); if (!sid) fail("Run this from inside a Claude Code session.");
    if (mine()) fail(`This session is already on the Desk: ${mine().p.name} · ${mine().s.name}.`);
    const pid = project();
    const s = run("session.add", pid, { id: sid, track: track(pid), name: flags.name || "Session", cwd: process.cwd() });
    say(`On the Desk: ${load(pid).name} · ${s.name}`);
  } else fail(`Unknown command "${cmd}". Run: desk help`);
} catch (e) { fail(e.message); }

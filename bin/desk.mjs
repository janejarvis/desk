#!/usr/bin/env node
// `desk` — how Claude sessions keep Diogo's Desk current. Run `desk help`.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ROOT, DESK_HOME, ME, HOME, expand, tilde, load, loadAll } from "../lib/store.mjs";
import { run, projectId, trackOf, ownerOf, STATUSES } from "../lib/ops.mjs";
import * as leads from "../lib/leads.mjs";

const HELP = `desk — keep ${ME}'s Desk current (roadmap, board, meetings).

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

Files (what you made for ${ME}: documents, PDFs, images, print files, artifacts)
  desk file add <full path or claude.ai artifact link> --title "<plain title>" [--note TEXT]
  desk files                                  list this project's files
  desk file remove <id>
    Register every file you hand ${ME}, when you hand it over. Artifacts you publish are
    picked up automatically.

Numbers (the Numbers tab)
  desk metric set <name> <value> [--label "<plain label>"] [--target T] [--note TEXT] [--better up|down] [--at YYYY-MM-DD] [--group "<name>"]
  desk metric remove <name>                   desk metrics   list them

Sales (only in the Sales area)
  desk leads [--stage S] [--owner NAME]       desk lead <name or id>   one lead, with its history
  desk lead <name or id> <stage> [--reason R] [--note TEXT] [--next TEXT --due YYYY-MM-DD] [--owner NAME]
  desk lead add "<company>" [--email E] [--phone P] [--website W] [--source referral|manual] [--note TEXT]

Meetings
  desk meeting done <id> --summary "<text>" --action "<text>" [--action ...]

Tracks and sessions
  desk track add "<name>" · desk track rename <id> "<name>"
  desk join [--project P] [--track T] [--name N]   put this session on the Desk

App
  desk open                                   start the Desk and open it
  desk restart                                restart it (replies in progress carry on)

Long jobs
  desk wait <process id> "<what it is>"       a job that outlives your reply (started detached):
    the Desk shows this session working on it, and messages you when that process ends.

Accounts (tools with one login per computer, e.g. Vercel)
  desk account vercel <name> | default        this project's runs use their own Vercel sign-in
  desk accounts                               which account each tool uses here

Steps only ${ME} can do (a sign-in, an approval, a login in a browser)
  desk ask "<button>" --run "<command>" [--why "<one sentence>"]   a pop-up with one button that
  desk ask "<button>" --open <url> [--why "<one sentence>"]          runs it / opens it; you get a
    message when it's done. Never tell ${ME} to type a command (no "! ..." in replies).

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
// so one client's work never leaks into another's (29 Oct 2026, Diogo's ruling).
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
// In the installed app (DESK_APP is the app's own program, set by its `desk` launcher) the app is
// the server: opening the Desk means opening the app, and the app restarts itself when asked.
function openApp() {
  const app = process.env.DESK_APP;
  if (process.platform === "darwin") execFileSync("open", [app.replace(/\/Contents\/MacOS\/[^/]+$/, "")]);
  else spawn(app, [], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } }).unref();
  say("Desk opened.");
}
async function open() {
  if (process.env.DESK_APP) return openApp();
  const port = process.env.DESK_PORT || 4848, url = `http://127.0.0.1:${port}`;
  const up = async () => { try { const r = await fetch(url + "/api/state"); return r.ok && Array.isArray((await r.json()).projects); } catch { return false; } }; // the Desk, not another app on the port
  if (!(await up())) {
    // Normally macOS keeps the Desk running (LaunchAgent com.blendd.desk); start that, else start it here.
    let viaLaunchd = false;
    try { execFileSync("launchctl", ["kickstart", `gui/${process.getuid()}/com.blendd.desk`], { stdio: "ignore" }); viaLaunchd = true; } catch {}
    if (!viaLaunchd) { const log = openSync(join(DESK_HOME, "desk.log"), "a"); spawn(process.execPath, [join(ROOT, "server.mjs")], { detached: true, stdio: ["ignore", log, log] }).unref(); }
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
  else if (cmd === "restart" && process.env.DESK_APP) {
    try { await fetch(`http://127.0.0.1:${process.env.DESK_PORT || 4848}/api/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); say("Desk restarted."); }
    catch { openApp(); } }
  else if (cmd === "restart") { // safe at any time: replies keep running and the new server picks them up
    try { execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.blendd.desk`], { stdio: "ignore" }); say("Desk restarted."); }
    catch { fail("The Desk isn't installed as a login item. Run: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blendd.desk.plist"); } }
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
  } else if (cmd === "file" && a1 === "add") {
    const pid = project();
    const f = run("file.add", pid, { path: a2, title: flags.title, note: flags.note, track: flags.track, session: mine()?.s.id || process.env.DESK_SESSION || "", source: "claude" });
    say(`On the Desk under Files: [${f.id}] ${f.title} (${f.kind})`);
  } else if (cmd === "file" && a1 === "remove") {
    run("file.remove", owner("files", a2), { id: a2 }); say("Removed from Files (the file itself is untouched).");
  } else if (cmd === "files") {
    const p = load(project());
    for (const f of (p.files || []).slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40)) say(`  ${f.at.slice(0, 10)}  ${f.kind.padEnd(8)} ${f.title}  [${f.id}]  ${f.url || tilde(f.path)}`);
    if (!(p.files || []).length) say("No files yet.");
  } else if (cmd === "meeting" && a1 === "done") {
    if (!a2 || !flags.summary) fail("Usage: desk meeting done <id> --summary \"...\" --action \"...\"");
    run("meeting.set", owner("meetings", a2), { id: a2, status: "read", summary: flags.summary, actions: (flags.action || []).map((title) => ({ title, added: true })) });
    say(`Saved: summary and ${(flags.action || []).length} action(s), recorded as on the board.`);
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
  } else if (cmd === "wait") {
    const id = Number(a1), what = String(a2 || "").trim();
    if (!id || !what) fail('Usage: desk wait <process id> "<what it is>"');
    try { process.kill(id, 0); } catch { fail(`Process ${id} isn't running, so there's nothing to wait for.`); }
    const m = mine(); const sid = m?.s.id || process.env.DESK_SESSION;
    if (!sid) fail("Only a session on the Desk can do this.");
    const pid = m?.p.id || project(); const s = load(pid).sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid));
    if (!s) fail("This session isn't on the Desk.");
    run("session.set", pid, { id: s.id, bg: [...(s.bg || []).filter((b) => b.pid !== id), { pid: id, what: what.slice(0, 120), at: new Date().toISOString() }] });
    say(`The Desk shows "${what}" as working and will message this session when process ${id} ends.`);
  } else if (cmd === "account" || cmd === "accounts") {
    // Which account this project's runs use for tools that keep one login per computer (lib/accounts.mjs).
    const { TOOLS, accountDir } = await import("../lib/accounts.mjs");
    const pid = project(), p = load(pid);
    if (cmd === "accounts" || !a1) { const acc = p.accounts || {}; for (const t of Object.keys(TOOLS)) say(`  ${t.padEnd(8)} ${acc[t] ? `"${acc[t]}" account (${tilde(accountDir(t, acc[t]))})` : "this computer's usual sign-in"}`); }
    else {
      if (!TOOLS[a1]) fail(`Separate accounts work for: ${Object.keys(TOOLS).join(", ")}.`);
      const name = a2 === "default" ? "" : a2; if (a2 === undefined) fail(`Usage: desk account ${a1} <account name, e.g. lqa> | default`);
      run("project.set", pid, { account: [a1, name] });
      say(name ? `${p.name} now uses its own "${name}" ${a1} account. If it isn't signed in yet: desk ask "Sign in to ${a1} (${name} account)" --run "${TOOLS[a1].login}" (it signs in to that account only).` : `${p.name} uses this computer's usual ${a1} sign-in again.`);
    }
  } else if (cmd === "ask") {
    // A step only the person can do (a sign-in, an approval): the Desk shows it as a pop-up with one
    // button that runs the command in its own window (or opens the page), then tells this session.
    const title = String(a1 || "").trim();
    if (!title || (!flags.run && !flags.open)) fail('Usage: desk ask "<button, e.g. Sign in to Vercel>" --run "<command>" | --open <url> [--why "<one plain sentence>"]');
    const m = mine(); const sid = m?.s.id || process.env.DESK_SESSION;
    if (!sid) fail("Only a session on the Desk can do this.");
    const pid = m?.p.id || project(); const s = load(pid).sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid));
    if (!s) fail("This session isn't on the Desk.");
    const ask = { id: Math.random().toString(36).slice(2, 10), title: title.slice(0, 80), why: String(flags.why || "").slice(0, 400), cmd: flags.run || "", url: flags.open || "", at: new Date().toISOString() };
    run("session.set", pid, { id: s.id, asks: [...(s.asks || []).filter((x) => x.title !== ask.title), ask] });
    say(`The Desk shows "${ask.title}" as a button for ${ME}. When it's done, this session gets a message and carries on; end your reply now and don't ask ${ME} to type anything.`);
  } else if (cmd === "metric" || cmd === "metrics") {
    const pid = project();
    if (cmd === "metrics" || !a1) { const p = load(pid); for (const m of p.metrics || []) say(`  ${m.key.padEnd(22)} ${String(m.value).padEnd(10)} ${m.label}${m.target ? ` (target ${m.target})` : ""}${m.note ? ` · ${m.note}` : ""}`); if (!(p.metrics || []).length) say("No numbers yet."); }
    else if (a1 === "set") { const m = run("metric.set", pid, { key: a2, value: pos[3], label: flags.label, note: flags.note, target: flags.target, better: flags.better, at: flags.at, group: flags.group }); say(`${m.label}: ${m.value}`); }
    else if (a1 === "remove") { run("metric.remove", pid, { key: a2 }); say("Removed."); }
    else fail("Try: desk metric set <name> <value> · desk metric remove <name> · desk metrics");
  } else if (cmd === "leads" || cmd === "lead") {
    const pid = project(); if (load(pid).kind !== "sales") fail("Leads live in the Sales area; this session isn't in it.");
    const line = (l) => `  ${(l.company || l.name).padEnd(34)} ${(leads.STAGE[l.stage] || l.stage).padEnd(14)} ${(leads.SOURCES[l.source?.kind] || l.source?.kind || "").padEnd(13)} ${l.owner || ""}${l.next?.due ? ` · next ${l.next.due}` : ""}  [${l.id}]`;
    if (cmd === "leads") { const ls = leads.list().filter((l) => (!flags.stage || l.stage === flags.stage) && (!flags.owner || (l.owner || "").toLowerCase() === flags.owner.toLowerCase())); for (const l of ls) say(line(l)); say(`${ls.length} lead(s).`); }
    else if (a1 === "add") { const l = leads.add({ company: a2, email: flags.email, phone: flags.phone, website: flags.website, source: flags.source, note: flags.note, owner: flags.owner }); say(`Added lead [${l.id}] ${l.company}`); }
    else if (a1 && a2 && (leads.STAGE[a2] || a2 === "note")) { const l = leads.find(a1); const u = leads.set(l.id, { stage: leads.STAGE[a2] ? a2 : undefined, reason: flags.reason, note: flags.note, next: flags.next, due: flags.due, owner: flags.owner }); say(`${u.company || u.name}: ${leads.STAGE[u.stage]}`); }
    else if (a1) { const l = leads.find(a1); say(line(l)); for (const k of ["email", "phone", "website"]) if (l[k]) say(`  ${k}: ${l[k]}`); if (l.next) say(`  next: ${l.next.text}${l.next.due ? ` (${l.next.due})` : ""}`); for (const t of (l.timeline || []).slice(-12)) say(`  ${(t.at || "").slice(0, 10)}  ${t.text}`); for (const m of (l.emails || []).slice(-5)) say(`  email ${(m.at || "").slice(0, 10)} ${m.state}: ${m.subject}`); }
    else fail("Try: desk leads · desk lead <name> · desk lead <name> <stage> · desk lead add \"<company>\"");
  } else fail(`Unknown command "${cmd}". Run: desk help`);
} catch (e) { fail(e.message); }

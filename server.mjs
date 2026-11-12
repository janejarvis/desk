#!/usr/bin/env node
// Diogo's Desk — a local app for every project: chats with Claude sessions, roadmaps, the board and
// meeting transcripts. 127.0.0.1 only. Data: data/projects/*.json (see lib/store.mjs).
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, watch, statSync, unlinkSync, createWriteStream, createReadStream, readdirSync, rmSync } from "node:fs";
import { execFileSync, execFile, spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
const HOME_DIR = homedir();
import { join, extname, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, DESK_HOME, ME, DATA, SHARED, SHARED_DATA, expand, tilde, load, loadAll, update } from "./lib/store.mjs";
import { run, createProject, ensureBrief, ensureChats } from "./lib/ops.mjs";
import { messages, lastWrite, live, agents, transcriptPath } from "./lib/sessions.mjs";
import { docxText } from "./lib/docx.mjs";
import * as leadsDb from "./lib/leads.mjs";
import * as sync from "./lib/sync.mjs";
const VERSION = (() => { try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; } catch { return ""; } })();

// What the installed app (app/main.cjs) does better than plain macOS tools, on every computer:
// notifications and file previews. Left empty, the Mac's own tools are used.
export const desk = { notify: null, thumbnail: null, restart: null, pickFolder: null };
const MAC = process.platform === "darwin", WIN = process.platform === "win32";
import { artifactsIn, readFrom } from "./lib/files.mjs";
import * as runner from "./lib/runner.mjs";
import { withShims } from "./lib/accounts.mjs";
import * as morningMod from "./lib/morning.mjs";
import * as chromeExt from "./lib/chrome.mjs";

const PORT = +(process.env.DESK_PORT || 4848);
const WEB = join(ROOT, "web");
const clients = new Set();
const streaming = new Map(); // session id -> reply text so far (so a page opened mid-reply catches up)

function broadcast(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(s);
}

// ---- what the page shows ----
const msgCache = new Map();
function convo(s) {
  const at = [s.id, ...(s.previousIds || [])].map((id) => lastWrite(id, s.cwd)).join(",");
  const c = msgCache.get(s.id);
  if (c && c.at === at) return c.msgs;
  const msgs = messages([...(s.previousIds || []), s.id], s.cwd);
  msgCache.set(s.id, { at, msgs });
  return msgs;
}

function sessionView(s, liveMap) {
  const l = liveMap.get(s.id);
  const msgs = s.started === false ? [] : convo(s);
  const last = msgs[msgs.length - 1];
  const lastAt = last ? Date.parse(last.at) || 0 : 0;
  let state = "idle";
  if (runner.isBusy(s.id) || l?.status === "busy" || (s.bg || []).length) state = "working";
  if (s.question && runner.questionOf(s.id)) state = "waiting";
  else if (last?.who === "claude" && lastAt > (Date.parse(s.seenAt || "") || 0) && Date.now() - lastAt < 3 * 864e5) state = "waiting";
  return { ...s, cwd: tilde(s.cwd), state, terminal: !!l?.interactive, lastAt, mine: !s.owner || s.owner === ME, last: last ? { who: last.who, text: last.text.slice(0, 220), at: last.at } : null };
}

// When the page's own files last changed: an open page reloads itself on a change (9 Nov 2026: a Desk window kept
// running the old page after an update, so a new button "didn't work").
const webStamp = () => { let t = 0; for (const f of ["app.js", "style.css", "index.html"]) try { t = Math.max(t, statSync(join(ROOT, "web", f)).mtimeMs); } catch {} return Math.round(t); };
function state() {
  const liveMap = live();
  return { me: ME, version: VERSION, web: webStamp(), sync: { ...sync.status, github: sync.githubUser(), shared: leadsDb.ready() || loadAll().some((p) => p.shared) }, voice: VOICE.ok,
    projects: loadAll().map((p) => ({ ...p, kind: p.kind || "project", folder: tilde(p.folder), sessions: p.sessions.map((s) => sessionView(s, liveMap)) })) };
}

// Jobs a session left running past its reply (`desk wait`): when one's process ends, it comes off
// the session and the session gets a message, so "I'll tell you when it's done" comes true.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function settleBg() {
  for (const p of loadAll()) for (const s of p.sessions) {
    const gone = (s.bg || []).filter((b) => !alive(b.pid));
    if (!gone.length) continue;
    try { run("session.set", p.id, { id: s.id, bg: s.bg.filter((b) => !gone.includes(b)) }); } catch { continue; }
    const list = gone.map((b) => `"${b.what}" (process ${b.pid}, started ${b.at.slice(11, 16)} UTC)`).join("; ");
    try { sendTo(p.id, s.id, `[From the Desk] The background job you asked the Desk to watch has ended: ${list}. Check how it ended (its log or output), update the Desk, and tell ${ME} the result in a short reply.`); } catch {}
  }
}

// Tell open pages when anything changes: a project file, a session's transcript, a session going busy.
let sig = "";
function check() {
  try { settleBg(); } catch {}
  try {
    const liveMap = live();
    const parts = [];
    for (const p of loadAll()) for (const s of p.sessions) parts.push(s.id, lastWrite(s.id, s.cwd), liveMap.get(s.id)?.status || "", runner.isRunning(s.id));
    const n = parts.join("|");
    if (n !== sig) { sig = n; broadcast({ type: "state" }); }
  } catch {}
}
setInterval(check, 2000);
let wt; try { mkdirSync(DATA, { recursive: true }); watch(DATA, () => { clearTimeout(wt); wt = setTimeout(() => broadcast({ type: "state" }), 120); }); } catch {}
// The shared projects and leads change on the other computer too (the sync writes them here).
let ws, wl; try { mkdirSync(SHARED_DATA, { recursive: true }); watch(SHARED_DATA, () => { clearTimeout(ws); ws = setTimeout(() => broadcast({ type: "state" }), 150); }); } catch {}
try { mkdirSync(join(SHARED, "sales", "leads"), { recursive: true }); watch(join(SHARED, "sales", "leads"), () => { clearTimeout(wl); wl = setTimeout(() => broadcast({ type: "leads" }), 200); }); } catch {}

// ---- "! command": run it in a real Terminal window, like ! in Claude Code ----
// Interactive commands (vercel login, gh auth login…) need a real terminal, so the Desk opens one in
// the session's folder and records it. When it finishes, its output is shown in the pane and goes to
// the session with the next message, as Claude Code does with !.
const RUN = process.env.DESK_RUN || join(DESK_HOME, "run"); // tests set their own, so they never pick up live replies
const clean = (t) => t.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "")
  .replace(/\r\n/g, "\n").replace(/[^\n]*\r(?!\n)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/^\^D\x08*/gm, "").trim();
// The Mac: a Terminal window running the command under `script`, which records everything it shows.
function macShell(id, cwd, cmd, p, s, log, done) {
  const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const inner = join(RUN, id + ".sh"), win = join(RUN, id + ".command");
  // The trap writes the exit code however the command ends, even if it calls exit itself.
  writeFileSync(inner, `trap 'echo $? > ${q(done).replace(/'/g, "'\\''")}' EXIT\ncd ${q(cwd)} || exit 1\n${cmd}\n`);
  writeFileSync(win, `#!/bin/zsh -l\nclear\nprintf '\\033]0;Desk · ${p.name.replace(/'/g, "")} · ${s.name.replace(/'/g, "")}\\007'\necho "Desk · ${p.name.replace(/"/g, "")} · ${s.name.replace(/"/g, "")}   (${tilde(cwd).replace(/"/g, "")})"\nprintf '%s\\n\\n' "$ "${q(cmd)}\nscript -q ${q(log)} /bin/zsh -l ${q(inner)}\necho\necho "${s.asking ? "Done. The Desk tells the session to carry on. You can close this window." : "Finished. The output is on the Desk and goes to the session with your next message. You can close this window."}"\n`, { mode: 0o755 });
  if (process.env.DESK_SHELL === "headless") spawn("/bin/zsh", [win], { stdio: "ignore" }); // tests: no window on the screen
  else execFileSync("open", ["-a", "Terminal", win]);
  return [inner, win];
}
// Windows: a PowerShell window; a transcript records what it shows, and the exit code is written at the end.
function winShell(id, cwd, cmd, p, s, log, done) {
  const ps1 = join(RUN, id + ".ps1"), q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  writeFileSync(ps1, [
    `$Host.UI.RawUI.WindowTitle = ${q(`Desk · ${p.name} · ${s.name}`)}`,
    `Write-Host ${q(`Desk · ${p.name} · ${s.name}   (${cwd})`)}`, `Write-Host ${q("> " + cmd)}`, `Write-Host ''`,
    `Start-Transcript -Path ${q(log)} | Out-Null`, `$code = 1`,
    `try { Set-Location -LiteralPath ${q(cwd)}; $global:LASTEXITCODE = 0`, cmd, `$code = if ($?) { $LASTEXITCODE } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }`,
    `finally { Stop-Transcript | Out-Null; Set-Content -LiteralPath ${q(done)} -Value $code }`,
    `Write-Host ''`, `Write-Host 'Finished. The output is on the Desk and goes to the session with your next message. You can close this window.'`,
  ].join("\r\n"), "utf8");
  spawn("cmd.exe", ["/c", "start", '""', "powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ps1], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return [ps1];
}
function shell(pid, sid, cmd, ask = null) {
  const p = load(pid); const s = p.sessions.find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error("That session isn't on the desk any more."), { user: true });
  cmd = String(cmd || "").trim(); if (!cmd) throw Object.assign(new Error("Type a command after the !"), { user: true });
  mkdirSync(RUN, { recursive: true });
  const id = randomUUID().slice(0, 8), cwd = expand(s.cwd) || HOME_DIR;
  const log = join(RUN, id + ".log"), done = join(RUN, id + ".done");
  const sw = { ...s, asking: !!ask };
  const files = WIN ? winShell(id, cwd, cmd, p, sw, log, done) : macShell(id, cwd, cmd, p, sw, log, done);
  const entry = { id, cmd, state: "running", at: new Date().toISOString(), ...(ask ? { ask: ask.title } : {}) };
  run("session.set", pid, { id: sid, pendingShell: [...(s.pendingShell || []), entry] });
  const t = setInterval(() => {
    if (!existsSync(done)) return;
    clearInterval(t);
    let out = ""; try { out = clean(readFileSync(log, "utf8")); } catch {}
    if (WIN) out = out.replace(/\*{20,}\n[\s\S]*?\*{20,}\n?/g, "").replace(/^Transcript started[^\n]*\n?/m, "").trim(); // PowerShell's own header and footer
    const code = (() => { try { return +readFileSync(done, "utf8").trim(); } catch { return null; } })();
    if (out.length > 8000) out = "…" + out.slice(-8000);
    const cur = load(pid).sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid));
    if (cur) run("session.set", pid, { id: cur.id, pendingShell: (cur.pendingShell || []).map((e) => (e.id === id ? { ...e, state: "done", code, output: out } : e)) });
    for (const f of [log, done, ...files]) try { unlinkSync(f); } catch {}
    if (ask && cur) try { sendTo(pid, cur.id, ask.resend || `[From the Desk] ${ME} clicked "${ask.title}" and the command above ran in its own window. Check whether it worked and carry on; if it didn't, ask again with \`desk ask\`.`); } catch {}
    broadcast({ type: "state" });
  }, 1000);
  setTimeout(() => clearInterval(t), 6 * 3600e3); // a window left open all day stops being watched
  return entry;
}
const shellNote = (s) => {
  const done = (s.pendingShell || []).filter((e) => e.state === "done");
  if (!done.length) return "";
  return `[Before this message I ran ${done.length === 1 ? "this command" : "these commands"} myself in a terminal, in ${tilde(expand(s.cwd))}:]\n` +
    done.map((e) => `$ ${e.cmd}   (exit ${e.code ?? "?"})\n\`\`\`\n${e.output || "(no output)"}\n\`\`\``).join("\n\n") + "\n\n";
};

// No Desk page open: tell Diogo with a plain Mac notification (the page shows its own when open).
function macNotify(pid, sid, error, text) {
  try {
    const p = load(pid), s = p.sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid));
    const msg = text || (error ? "Stopped with an error." : "Replied. Open the Desk to read it.");
    if (desk.notify) return desk.notify("Desk · " + p.name, (s?.name ? s.name + ": " : "") + msg);
    if (MAC) execFile("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title ${JSON.stringify("Desk · " + p.name)} subtitle ${JSON.stringify(s?.name || "")}`], () => {});
  } catch {}
}

// ---- sending a message to a session ----
// What to do with a run's events, for one session. Built when a message is sent, and rebuilt for
// runs a restarted server picks up again (they keep going while the server restarts).
// Claude's own sign-in ran out (3 Nov 2026: replies came back as "Failed to authenticate: OAuth session
// expired" and Diogo was left to work out what to type).
const SIGNED_OUT = /failed to authenticate|oauth (session|token) (has )?expired|please run \/login|not logged in|invalid api key|authentication_error/i;
function handler(pid, sid, wasNew, sent = "") {
  let cur = sid;
  return (ev) => {
    if (ev.type === "start") { streaming.set(cur, ""); if (wasNew) run("session.set", pid, { id: cur, started: true }); }
    if (ev.type === "id") { const old = cur; cur = ev.id; streaming.set(cur, streaming.get(old) || ""); streaming.delete(old); try { run("session.set", pid, { id: old, newId: cur }); } catch {} broadcast({ type: "renamed", from: old, to: cur }); return; }
    if (ev.type === "delta") streaming.set(cur, (streaming.get(cur) || "") + ev.text);
    if (ev.type === "question") { try { run("session.set", pid, { id: cur, question: ev.question }); } catch {} if (!clients.size) macNotify(pid, cur, null, "asks you something. Open the Desk to answer."); }
    if (ev.type === "answered" || ev.type === "done") { try { if (load(pid).sessions.find((x) => x.id === cur)?.question) run("session.set", pid, { id: cur, question: null }); } catch {} }
    if (ev.type === "denied") try { run("session.set", pid, { id: cur, addDenied: ev.items.map((d) => ({ ...d, at: new Date().toISOString() })) }); } catch {}
    if (ev.type === "message") { const t = streaming.get(cur); if (t && !t.endsWith("\n\n")) streaming.set(cur, t + "\n\n"); }
    if (ev.type === "done" && !clients.size) macNotify(pid, cur, ev.error);
    if (ev.type === "done") { streaming.delete(cur); msgCache.delete(cur); if (ev.error && wasNew) try { run("session.set", pid, { id: cur, started: false }); } catch {} }
    // Background helpers the end of the reply stopped before they finished: the session is told to
    // carry the work on in the foreground, at most twice in a row (then it's left to Diogo).
    if ((ev.type === "done" && !ev.error && ev.cutOff?.length) || (ev.type === "cutoff" && ev.cutOff?.length)) {
      const n = (autoGo.get(cur) || 0) + 1; autoGo.set(cur, n);
      if (n <= 2) setTimeout(() => { try { sendTo(pid, cur, `[From the Desk] When your reply ended, ${ev.cutOff.length === 1 ? "this background job was" : "these background jobs were"} stopped before finishing: ${ev.cutOff.map((d) => `"${d}"`).join(", ")}. On the Desk nothing in the background survives the end of a reply. Carry the work on now in the foreground: do it yourself or run helpers synchronously (never run_in_background), and reply only when it's done or truly blocked.`, { auto: true }); } catch {} }, 1500);
    }
    if (ev.type === "done" && ev.error && SIGNED_OUT.test(ev.error)) {
      ev = { ...ev, error: "Claude is signed out on this computer." };
      // On the Mac the fix is the Desk's own long-lived key (bin/desk-claude-token.py), not another everyday sign-in.
      const mk = MAC ? { title: "Give the Desk its own Claude key", why: "Claude's sign-in ran out, so it couldn't reply. This makes the Desk a long-lived key of its own, so it stops asking every day. Your browser opens: sign in and click Authorize. Your message is sent again after.", cmd: `python3 ${JSON.stringify(join(ROOT, "bin", "desk-claude-token.py"))}` } : { title: "Sign in to Claude again", why: "Claude's sign-in on this computer ran out, so it couldn't reply. A window opens: sign in and click Authorize. Your message is sent again after.", cmd: "claude auth login" };
      try { addAsk(pid, cur, { ...mk, resend: sent, kind: "login" }); } catch {}
    }
    broadcast({ ...ev, type: "stream", kind: ev.type, session: cur });
    if (ev.type === "done" || ev.type === "start") check();
  };
}
// A message that waited for a busy session, turned back into a job when its turn comes.
runner.onQueued((pid, sid, text) => {
  const p = load(pid); const s = p.sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid));
  if (!s) return null;
  return { job: { session: { ...s, cwd: expand(s.cwd), started: true }, project: p, trackName: p.tracks.find((t) => t.id === s.track)?.name || "", text, fork: false }, on: handler(pid, s.id, false, text) };
});
// ---- the morning run (lib/morning.mjs): every day at 8:00, or at start if 8:00 passed without it ----
const MORNING = join(DATA, "..", "morning.json"); // next to the projects (tests with their own DESK_DATA get their own)
const readMorning = () => { try { return JSON.parse(readFileSync(MORNING, "utf8")); } catch { return null; } };
function morningRun({ force = false, send = true } = {}) {
  const d = morningMod.today(), last = readMorning();
  if (!force && last?.date === d) return last;
  const r = morningMod.plan(d);
  const out = { ...r, at: new Date().toISOString(), sent: [] };
  // One message per chat, a few minutes apart, so the Mac isn't asked to run every chat at once.
  if (send) r.chats.forEach((c, i) => {
    out.sent.push({ project: c.project, session: c.session, name: c.name, due: c.due.length, undated: c.undated.length, open: (c.open || []).length });
    setTimeout(() => { try { sendTo(c.project, c.session, morningMod.chatMessage(c, d), { auto: true }); } catch {} }, i * 3 * 60e3);
  });
  mkdirSync(dirname(MORNING), { recursive: true }); writeFileSync(MORNING, JSON.stringify(out, null, 2) + "\n");
  if (out.total) {
    const msg = `${out.total} thing${out.total === 1 ? "" : "s"} wait on you. ${out.items.slice(0, 2).map((x) => x.title).join(" · ")}`;
    if (desk.notify) desk.notify("Desk · Good morning", msg.slice(0, 180));
    else if (MAC) execFile("osascript", ["-e", `display notification ${JSON.stringify(msg.slice(0, 180))} with title "Desk · Good morning"`], () => {});
  }
  broadcast({ type: "morning" });
  return out;
}
// Claude Code keeps a copy of files for its edit previews in /tmp/claude-<uid>/bash-edit-diff and never removes them:
// 27 GB by 12 Nov 2026, the disk full a second time. Every hour, copies older than 6 hours go.
function tidyTmp() {
  const dir = join("/private/tmp", `claude-${process.getuid?.() ?? 501}`, "bash-edit-diff");
  try { for (const f of readdirSync(dir)) { const pth = join(dir, f); try { if (Date.now() - statSync(pth).mtimeMs > 6 * 3600e3) rmSync(pth, { recursive: true, force: true }); } catch {} } } catch {}
}
if (MAC) { setTimeout(tidyTmp, 30e3); setInterval(tidyTmp, 3600e3).unref?.(); }
// Every 2 minutes: no Chrome extension connection → start Chrome in the background (lib/chrome.mjs), so chats keep it.
if (MAC && process.env.DESK_CHROME !== "off") setInterval(() => { if (!chromeExt.connected()) chromeExt.ensure({ wait: 15000 }).catch(() => {}); }, 120e3).unref?.();
if (process.env.DESK_MORNING !== "off") setInterval(() => { const n = new Date(); if (n.getHours() >= 8 && readMorning()?.date !== morningMod.today()) morningRun(); }, 60e3).unref?.();

const autoGo = new Map(); // session -> automatic "carry on" messages sent in a row
function sendTo(pid, sid, text, { auto = false } = {}) {
  if (!auto) autoGo.delete(sid);
  const p = load(pid);
  const s = p.sessions.find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error("That session isn't on the desk any more."), { user: true });
  if (s.owner && s.owner !== ME) throw Object.assign(new Error(`This is ${s.owner}'s session; it runs on their computer. Start your own with + New session.`), { user: true });
  const note = shellNote(s);
  if (note) { text = note + text; run("session.set", pid, { id: s.id, pendingShell: (s.pendingShell || []).filter((e) => e.state !== "done") }); }
  const fork = s.started !== false && !runner.isRunning(s.id) && !!live().get(s.id)?.interactive;
  runner.send({ session: { ...s, cwd: expand(s.cwd) }, project: p, trackName: p.tracks.find((t) => t.id === s.track)?.name || "", text, fork }, handler(pid, s.id, s.started === false, text));
}

// Steps only the person can do (a sign-in, an approval), asked for by the session with `desk ask` or by
// the Desk itself, shown as a pop-up with one button instead of "type ! <command>" (Diogo, 3 Nov 2026:
// "I don't want to write terminal code in the Desk"). The button runs the command in a window of its own
// or opens the page; when it's done, the session is told and carries on.
function addAsk(pid, sid, a) {
  const s = load(pid).sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid)); if (!s) return;
  const ask = { id: randomUUID().slice(0, 8), title: String(a.title || "One step for you").slice(0, 80), why: String(a.why || "").slice(0, 400), cmd: a.cmd || "", url: a.url || "", resend: a.resend || "", kind: a.kind || "", at: new Date().toISOString() };
  run("session.set", pid, { id: s.id, asks: [...(s.asks || []).filter((x) => x.title !== ask.title), ask] });
  broadcast({ type: "state" });
}
// The button's command runs hidden, in a pseudo-terminal of its own (bin/pty-run.py; Windows: a hidden
// PowerShell), not in a Terminal window (Diogo, 3 Nov 2026: "it's still opening terminal in the
// foreground"). The sign-in tools open the browser themselves; the pop-up shows any link or code they
// print, and a box to answer if one asks a question.
const askRuns = new Map();
function askRun(pid, s, a) {
  const id = randomUUID().slice(0, 8), cwd = expand(s.cwd) || HOME_DIR;
  const child = WIN ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", a.cmd], { cwd, windowsHide: true, env: { ...process.env, PATH: withShims(load(pid), process.env.PATH || "") } })
    : spawn("/usr/bin/python3", [join(ROOT, "bin", "pty-run.py"), a.cmd], { cwd, env: { ...process.env, TERM: "xterm-256color", PATH: withShims(load(pid), process.env.PATH || "") } });
  const r = { id, pid, sid: s.id, title: a.title, kind: a.kind || "", out: "", done: false, code: null, child };
  askRuns.set(id, r);
  let t = null; const tell = () => { clearTimeout(t); t = setTimeout(() => broadcast({ type: "askrun", run: askView(r) }), 120); };
  const add = (d) => { r.out = (r.out + String(d)).slice(-40000); tell(); };
  child.stdout.on("data", add); child.stderr.on("data", add);
  child.on("error", (e) => add(`\n${e.message}\n`));
  child.on("close", (code) => {
    Object.assign(r, { done: true, code }); broadcast({ type: "askrun", run: askView(r) });
    setTimeout(() => askRuns.delete(id), 10 * 60e3);
    if (r.cancelled) return;
    const cur = load(pid).sessions.find((x) => x.id === s.id || (x.previousIds || []).includes(s.id)); if (!cur) return;
    const tail = clean(r.out).slice(-3000) || "(it printed nothing)";
    try { sendTo(pid, cur.id, code === 0 && a.resend ? a.resend : `[From the Desk] ${ME} clicked "${a.title}". It ran \`${a.cmd}\` (hidden, in ${tilde(cwd)}) and ended with exit code ${code}. What it printed:\n\`\`\`\n${tail}\n\`\`\`\nCheck whether it worked and carry on; if it didn't, ask again with \`desk ask\`.`); } catch {}
  });
  setTimeout(() => { if (!r.done) { r.cancelled = true; try { child.kill(); } catch {} } }, 30 * 60e3); // a sign-in left open for half an hour is given up
  return askView(r);
}
const askView = (r) => ({ id: r.id, project: r.pid, session: r.sid, title: r.title, kind: r.kind, out: clean(r.out).slice(-4000), waiting: /[?:>]\s*$/.test(clean(r.out.slice(-400))), done: r.done, code: r.code, cancelled: !!r.cancelled });
function askInput(id, text) { const r = askRuns.get(id); if (!r || r.done) throw Object.assign(new Error("That step has already finished."), { user: true }); r.child.stdin.write(String(text) + (WIN ? "\r\n" : "\n")); return { ok: true }; }
function askCancel(id) { const r = askRuns.get(id); if (r && !r.done) { r.cancelled = true; try { r.child.kill(); } catch {} } return { ok: true }; }
function answerAsk(pid, sid, id, answer) {
  const s = load(pid).sessions.find((x) => x.id === sid); const a = (s?.asks || []).find((x) => x.id === id);
  if (!a) throw Object.assign(new Error("That step is already done."), { user: true });
  const rest = () => run("session.set", pid, { id: s.id, asks: (load(pid).sessions.find((x) => x.id === s.id)?.asks || []).filter((x) => x.id !== id) });
  if (answer === "dismiss") { rest(); return { ok: true }; }
  if (answer === "open" && a.url) { execFile(WIN ? "cmd" : "open", WIN ? ["/c", "start", "", a.url] : [a.url], () => {}); return { ok: true }; }
  if (answer === "done") { rest(); sendTo(pid, s.id, a.resend || `[From the Desk] ${ME} did the step you asked for: "${a.title}". Check it worked and carry on.`); return { ok: true }; }
  if (answer === "run" && a.cmd) { rest(); return askRun(pid, s, a); }
  throw Object.assign(new Error("Nothing to do for that step."), { user: true });
}

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "meeting";

function readMeetingPrompt(p, m) {
  const path = join(expand(p.transcripts), m.file);
  return [
    `Please read the meeting transcript at ${path} (${p.name} · ${p.tracks.find((t) => t.id === m.track)?.name}; meeting "${m.title}", ${m.date}). You manage what comes out of it: ${ME} (the user, who is usually in the meeting) doesn't pick anything.`,
    `1. Run \`desk status\` and read the board and roadmap as they stand.`,
    `2. Work out what the meeting DECIDED: for each topic, who will do what, by when, and what was found to be already solved or no longer needed. Decisions late in the meeting override earlier ideas.`,
    `3. Make the board match those decisions, as one piece:`,
    `   - Every action gets a card. If a card for it exists, rewrite it to match the decision: title, owner, status, who it waits on, due date. Don't just add a note: if the meeting gave the job to someone else, the card must now say so.`,
    `   - Status from the decision: ours and started = doing; ours, not started = todo; someone else does it or owes us something = waiting --waiting <that person>; can't start until another card is done = blocked --why "after: <that card>".`,
    `   - Merge cards that are now the same job (keep one, remove the rest). Remove cards the meeting made pointless (already exists, dropped, superseded), and mark done what it finished.`,
    `   - Update milestones whose scope or date changed.`,
    `4. Follow this project's own standing rules for meetings (for example, logging the meeting and its hours where the project keeps them), and tick any ongoing duty you did with \`desk todo tick <id>\`.`,
    `5. Read the affected cards back with \`desk status\` and check they tell one consistent story with what was decided: right people, no duplicates, nothing left that the meeting settled. Fix anything that doesn't.`,
    `6. Record the meeting: \`desk meeting done ${m.id} --summary "<2 to 4 plain sentences>" --action "<action>" --action "<action>"\` — one --action per action, as it now reads on the board.`,
    `Then reply with the summary and a short list of what you added, changed (and why), merged, removed or finished on the board.`,
  ].join("\n");
}

const fillPrompt = (p, t) => [
  `${ME}'s Desk shows a roadmap and a board for ${p.name} · ${t.name}, and they're empty or out of date. From what you know about this work (this conversation, the project's plan and notes), set them up with the desk command:`,
  `1. The track's milestones in order: \`desk milestone add "<title>" --status done|now|next\` (add --due YYYY-MM-DD only for a real date). Usually 3 to 6; exactly one "now".`,
  `2. The open to-dos under the right milestone with their real status: doing, blocked (--why), waiting (--waiting <name>), sent (--to <name>), or todo. Recently finished ones as done.`,
  `Only real work you know about; don't invent dates or tasks. Run \`desk status\` first so you don't duplicate anything. Reply with two lines on what you set up.`,
].join("\n");

// ---- attachments (photos, documents, videos…) for a chat ----
// Saved under uploads/<project>/ on this Mac; the message then lists their paths so the session
// reads them itself. Only files in uploads/ are ever served back (for thumbnails).
const UPLOADS = join(DESK_HOME, "uploads");
const MAX_UPLOAD = 500 * 1024 * 1024;
// ---- voice: hold the mic, speak, let go; the words go into the message box ----
// Speech is turned into text on this computer by the local whisper server (whisper.cpp); ffmpeg
// turns the browser's recording into the 16 kHz WAV it reads. No whisper server: no mic button.
const VOICE = { ok: false, url: process.env.DESK_WHISPER || "http://127.0.0.1:8766/inference" };
async function checkVoice() {
  try { const r = await fetch(VOICE.url.replace(/\/inference$/, "/"), { signal: AbortSignal.timeout(3000) }); VOICE.ok = r.ok && !!(await which("ffmpeg")); } catch { VOICE.ok = false; }
}
const which = (cmd) => new Promise((r) => execFile(WIN ? "where" : "which", [cmd], (e, out) => r(e ? null : String(out).trim().split(/\r?\n/)[0])));
checkVoice(); setInterval(checkVoice, 5 * 60e3).unref?.();
async function voice(req, res) {
  const tmp = join(tmpdir(), "desk-voice-" + randomUUID().slice(0, 8)), inF = tmp + ".webm", outF = tmp + ".wav";
  try {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 25e6) throw Object.assign(new Error("That recording is too long."), { user: true }); chunks.push(c); }
    writeFileSync(inF, Buffer.concat(chunks));
    await new Promise((ok, bad) => execFile("ffmpeg", ["-y", "-loglevel", "error", "-i", inF, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outF], { timeout: 60000 }, (e) => (e ? bad(e) : ok())));
    const form = new FormData();
    form.append("file", new Blob([readFileSync(outF)], { type: "audio/wav" }), "voice.wav");
    form.append("response_format", "json"); form.append("temperature", "0");
    const r = await fetch(VOICE.url, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const j = await r.json();
    json(res, 200, { text: String(j.text || "").replace(/\s+/g, " ").replace(/^\s*\[[^\]]*\]\s*/, "").trim() });
  } catch (e) { json(res, e.user ? 400 : 500, { error: e.user ? e.message : "Couldn't turn that into text. Try again." }); }
  finally { for (const f of [inF, outF]) try { unlinkSync(f); } catch {} }
}

async function upload(req, res, q) {
  try {
    const p = load(q.get("project"));
    const raw = String(q.get("name") || "file").split(/[\\/]/).pop();
    const ext = (raw.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0].toLowerCase();
    const base = raw.slice(0, raw.length - ext.length).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
    const dir = join(UPLOADS, p.id); mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    let name = `${stamp}_${base}${ext}`, n = 2;
    while (existsSync(join(dir, name))) name = `${stamp}_${base}-${n++}${ext}`;
    const path = join(dir, name);
    const out = createWriteStream(path);
    let size = 0, tooBig = false;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_UPLOAD) { tooBig = true; break; } if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); }
    await new Promise((r) => out.end(r));
    if (tooBig) { try { unlinkSync(path); } catch {} return json(res, 413, { error: "That file is over 500 MB." }); }
    json(res, 200, { path, name: raw, size, type: req.headers["content-type"] || "" });
  } catch (e) { json(res, 400, { error: e.message }); }
}
// A project's logo, uploaded from the + Project form: kept with the page (web/logos/<id>.<ext>).
async function saveLogo(req, res, q) {
  try {
    const pid = load(q.get("project")).id;
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg", "image/webp": ".webp" }[req.headers["content-type"]];
    if (!ext) return json(res, 400, { error: "The logo has to be a PNG, JPG, SVG or WebP image." });
    let b = []; let n = 0; for await (const c of req) { n += c.length; if (n > 5e6) return json(res, 413, { error: "Keep the logo under 5 MB." }); b.push(c); }
    writeFileSync(join(WEB, "logos", pid + ext), Buffer.concat(b));
    run("project.set", pid, { logo: `/logos/${pid}${ext}?v=${Date.now()}` });
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: e.message }); }
}
function sendFile(res, path) {
  const f = String(path || "");
  if (!f.startsWith(UPLOADS + "/") || f.includes("..") || !existsSync(f)) { res.writeHead(404); return res.end("Not found"); }
  const t = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".mp4": "video/mp4", ".mov": "video/quicktime", ".pdf": "application/pdf" }[extname(f).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": t, "Cache-Control": "max-age=86400" });
  createReadStream(f).pipe(res);
}

// ---- Files: what Claude made, previewed in the Files tab and in chats ----
// Only files registered on a project are ever served or opened, nothing else on disk.
const THUMBS = join(DESK_HOME, "cache", "thumbs");
const fileOf = (pid, id) => { const f = (load(pid).files || []).find((x) => x.id === id); if (!f || !f.path || !existsSync(f.path)) throw Object.assign(new Error("That file isn't there any more."), { user: true }); return f; };
const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".heic": "image/heic",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8" };
// /f/<project>/<id>/<name> serves the file itself; /f/<project>/<id>/<other path> serves files next
// to it (a page's own images and styles), never outside its folder.
function viewFile(res, pathname) {
  const [, , pid, id, ...rest] = pathname.split("/").map(decodeURIComponent);
  const f = fileOf(pid, id), dir = dirname(f.path);
  const want = rest.join("/");
  let target = f.path;
  if (want && want !== basename(f.path)) {
    target = join(dir, want);
    if (!target.startsWith(dir + "/") || target.includes("/../") || !existsSync(target) || !statSync(target).isFile()) { res.writeHead(404); return res.end(); }
  }
  const ext = extname(target).toLowerCase();
  const head = { "Content-Type": MIME[ext] || MIME_EXTRA[ext] || "application/octet-stream", "Content-Length": statSync(target).size, "Cache-Control": "no-cache",
    // A sealed-off page counts as "another site", so let it read the files in its own folder (its
    // models, images, data). Nothing outside that folder is reachable through this route.
    "Access-Control-Allow-Origin": "*" };
  // A page Claude made runs sealed off: it can't reach the Desk or its data. (Only pages: Chrome
  // won't show a PDF in a sandboxed frame.)
  if (ext === ".html" || ext === ".htm") head["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-forms";
  res.writeHead(200, head);
  createReadStream(target).pipe(res);
}
const MIME_EXTRA = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".stl": "model/stl", ".3mf": "model/3mf" };

// Previews come from macOS Quick Look, made in the background two at a time (it's slow and must
// never hold up the server), cached by file and change time, and prepared ahead for every file.
const thumbJobs = new Map(); let thumbActive = 0; const thumbQueue = [];
const thumbKey = (f) => join(THUMBS, `${f.id}-${Math.round(statSync(f.path).mtimeMs)}.png`);
const NO_THUMB = new Set();
function makeThumb(f) {
  const key = thumbKey(f);
  if (existsSync(key)) return Promise.resolve(key);
  if (NO_THUMB.has(key) || f.kind === "print" || f.kind === "archive") return Promise.resolve(null); // Quick Look can't draw these; the page draws STLs itself
  if (thumbJobs.has(key)) return thumbJobs.get(key);
  const job = new Promise((resolve) => {
    thumbQueue.push(() => {
      thumbActive++;
      const done = (png) => { if (png) { mkdirSync(THUMBS, { recursive: true }); writeFileSync(key, png); } else NO_THUMB.add(key); thumbActive--; thumbJobs.delete(key); resolve(png ? key : null); nextThumb(); };
      if (desk.thumbnail) return desk.thumbnail(f.path).then(done, () => done(null));
      if (!MAC) return done(null);
      const tmp = join(tmpdir(), "desk-ql-" + randomUUID().slice(0, 8)); mkdirSync(tmp, { recursive: true });
      execFile("qlmanage", ["-t", "-s", "600", "-o", tmp, f.path], { timeout: 30000 }, () => {
        let made = null; try { made = readdirSync(tmp).find((x) => x.endsWith(".png")); } catch {}
        if (made) { mkdirSync(THUMBS, { recursive: true }); writeFileSync(key, readFileSync(join(tmp, made))); } else NO_THUMB.add(key);
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
        thumbActive--; thumbJobs.delete(key); resolve(made ? key : null); nextThumb();
      });
    });
    nextThumb();
  });
  thumbJobs.set(key, job);
  return job;
}
function nextThumb() { while (thumbActive < 2 && thumbQueue.length) thumbQueue.shift()(); }
async function thumb(res, q) {
  const f = fileOf(q.get("project"), q.get("id"));
  const key = await makeThumb(f);
  if (!key) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
  createReadStream(key).pipe(res);
}
function warmThumbs() {
  for (const p of loadAll()) for (const f of p.files || []) if (f.path && f.kind !== "image" && existsSync(f.path)) makeThumb(f).catch(() => {});
}
setTimeout(warmThumbs, 3000); setInterval(warmThumbs, 10 * 60e3);

// Artifacts a session publishes land in Files on their own: new transcript lines are checked every
// 30 seconds (from where the server started; earlier ones were filled in once, by hand).
const scanned = new Map();
function scanArtifacts() {
  for (const p of loadAll()) for (const s of p.sessions) {
    if (s.started === false) continue;
    const t = transcriptPath(s.id, s.cwd); if (!t) continue;
    const from = scanned.get(t);
    if (from === undefined) { try { scanned.set(t, statSync(t).size); } catch {} continue; }
    const { lines, end } = readFrom(t, from); scanned.set(t, end);
    for (const a of artifactsIn(lines)) try { run("file.add", p.id, { url: a.url, title: a.title, at: a.at, session: s.id, source: "artifact" }); } catch {}
  }
}
setInterval(scanArtifacts, 30000); setTimeout(scanArtifacts, 2000);

// ---- HTTP ----
async function body(req) {
  let b = ""; for await (const c of req) { b += c; if (b.length > 5e6) throw Object.assign(new Error("That's too large."), { user: true }); }
  try { return JSON.parse(b || "{}"); } catch { throw Object.assign(new Error("Bad request."), { user: true }); }
}
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

let steerOwner = null;
const routes = {
  "GET /api/state": () => state(),
  "POST /api/restart": () => { if (!desk.restart) throw Object.assign(new Error("Only the Desk app restarts this way; here use: desk restart"), { user: true }); setTimeout(desk.restart, 300); return { ok: true }; },
  "GET /api/messages": (q) => {
    const p = load(q.get("project")); const s = p.sessions.find((x) => x.id === q.get("session"));
    if (!s) return { messages: [] };
    return { messages: s.started === false ? [] : convo(s), streaming: streaming.get(s.id) ?? null };
  },
  "GET /api/agents": (q) => {
    const p = load(q.get("project")); const s = p.sessions.find((x) => x.id === q.get("session"));
    if (!s || s.started === false) return { agents: [] };
    return { agents: [s.id, ...(s.previousIds || [])].flatMap((id) => agents(id, s.cwd)).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")) };
  },
  "GET /api/transcript": (q) => {
    const p = load(q.get("project")); const m = p.meetings.find((x) => x.id === q.get("id"));
    if (!m) return { text: "" };
    try { return { text: readFileSync(join(expand(p.transcripts), m.file), "utf8").slice(0, 200000) }; } catch { return { text: "(The file isn't there any more.)" }; }
  },
  "POST /api/op": (b) => ({ result: run(b.op, b.project, b) }),
  "POST /api/send": (b) => { if (!String(b.text || "").trim()) throw Object.assign(new Error("Type a message first."), { user: true }); sendTo(b.project, b.session, String(b.text)); return { ok: true }; },
  // Delete: the file goes to the Trash (it can be put back from there) and leaves Files.
  // An artifact only leaves Files; the page itself lives on claude.ai.
  "POST /api/filedelete": (b) => {
    const f = (load(b.project).files || []).find((x) => x.id === b.id);
    if (!f) throw Object.assign(new Error("That file is already gone."), { user: true });
    if (f.path && existsSync(f.path)) {
      try { execFileSync("/usr/bin/trash", [f.path], { timeout: 15000, stdio: "ignore" }); } // macOS's own: recoverable from the Trash
      catch { throw Object.assign(new Error("Couldn't move it to the Trash."), { user: true }); }
    }
    run("file.remove", b.project, { id: b.id });
    return { ok: true, trashed: !!f.path };
  },
  "POST /api/fileopen": (b) => { const f = fileOf(b.project, b.id); execFileSync("open", b.finder ? ["-R", f.path] : [f.path]); return { ok: true }; },
  "POST /api/project": (b) => createProject(b),
  // ---- Sales: the leads, their numbers and the outreach (lib/leads.mjs) ----
  "GET /api/leads": () => ({ leads: leadsDb.list(), stages: leadsDb.STAGES, lost: leadsDb.LOST, notLead: leadsDb.NOT_LEAD, services: leadsDb.SERVICES, sources: leadsDb.SOURCES, numbers: leadsDb.numbers(), outreach: leadsDb.outreach() }),
  "POST /api/lead": (b) => { const l = b.op === "add" ? leadsDb.add(b) : leadsDb.set(b.id, b); broadcast({ type: "leads" }); return l; },
  // ---- voice: speech to text on this computer (the local whisper server) ----
  "GET /api/voice": () => ({ ok: VOICE.ok }),
  // Connect: sync now, letting GitHub's sign-in window open (the first time on a computer).
  "POST /api/sync": async (b) => { if (b.github) sync.setGithubUser(b.github); const s = await sync.syncNow({ interactive: true }); broadcast({ type: "state" }); broadcast({ type: "leads" }); return s; },
  // The one Desk window the STEER gadget drives: the last one focused, whatever browser it's in.
  "POST /api/steer": (b) => { steerOwner = String(b.id || "").slice(0, 40) || steerOwner; broadcast({ type: "steer", owner: steerOwner }); return { owner: steerOwner }; },
  "GET /api/steer": () => ({ owner: steerOwner }),
  // The system's own folder picker (the app's, or the Mac's when the Desk runs in a browser).
  "POST /api/pick-folder": async () => {
    if (desk.pickFolder) return { folder: await desk.pickFolder() };
    if (!MAC) return { folder: null, why: "Type the folder instead." };
    try { return { folder: execFileSync("osascript", ["-e", 'POSIX path of (choose folder with prompt "Pick the project\'s folder")'], { encoding: "utf8", timeout: 300000 }).trim().replace(/\/$/, "") }; }
    catch { return { folder: null }; }
  },
  "POST /api/briefopen": (b) => { execFileSync("open", [expand(ensureBrief(load(b.project)))]); return { ok: true }; },
  "GET /api/brief": (q) => { const p = load(q.get("project")); const path = expand(ensureBrief(p)); return { path: tilde(path), text: existsSync(path) ? readFileSync(path, "utf8").slice(0, 200000) : "" }; },
  "POST /api/shell": (b) => shell(b.project, b.session, b.cmd),
  "GET /api/morning": () => { const m = readMorning(); return m ? { ...m, items: m.items.map((x) => ({ ...x, done: (load(x.project).todos || []).find((t) => t.id === x.id)?.status === "done" })) } : null; },
  "POST /api/morning": (b) => morningRun({ force: true, send: b.send !== false }),
  "POST /api/answer": (b) => { if (!runner.answer(b.session, b.request_id, b.answers || {})) throw Object.assign(new Error("That question was already answered or the chat stopped."), { user: true }); try { run("session.set", b.project, { id: b.session, question: null }); } catch {} return { ok: true }; },
  "POST /api/chrome": () => chromeExt.ensure(),
  "POST /api/ask": (b) => answerAsk(b.project, b.session, b.id, b.answer),
  "POST /api/askinput": (b) => askInput(b.run, b.text),
  "POST /api/askcancel": (b) => askCancel(b.run),
  "POST /api/addask": (b) => (addAsk(b.project, b.session, b), { ok: true }),
  "POST /api/stop": (b) => ({ stopped: runner.stop(b.session) }),
  "POST /api/session": (b) => {
    const p = load(b.project);
    const cwd = expand(String(b.cwd || "").trim() || p.folder);
    if (!existsSync(cwd)) throw Object.assign(new Error(`There's no folder ${tilde(cwd)}.`), { user: true });
    return run("session.add", b.project, { id: randomUUID(), track: b.track, name: b.name, cwd, started: false });
  },
  "POST /api/meeting": (b) => {
    const p = load(b.project);
    let docx = null;
    if (b.docx) { // a Word file: keep it, and read its text (lib/docx.mjs)
      docx = Buffer.from(String(b.docx), "base64");
      try { b.text = docxText(docx); }
      catch { throw Object.assign(new Error("Couldn't read that Word file. Try pasting its text instead."), { user: true }); }
    }
    const text = String(b.text || ""); if (!text.trim()) throw Object.assign(new Error("Paste or choose a transcript first."), { user: true });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10);
    const dir = expand(p.transcripts); mkdirSync(dir, { recursive: true });
    const ext = /^\.(txt|md|vtt|srt)$/.test(b.ext || "") ? b.ext : ".txt";
    let file = `${date}_${slug(b.title || "meeting")}${ext}`, n = 2;
    while (existsSync(join(dir, file))) file = `${date}_${slug(b.title || "meeting")}-${n++}${ext}`;
    writeFileSync(join(dir, file), text);
    if (docx) writeFileSync(join(dir, file.replace(/\.txt$/, ".docx")), docx);
    const m = run("meeting.add", b.project, { track: b.track, title: b.title, date, file });
    if (b.read) readMeeting(b.project, m.id, b.read);
    return m;
  },
  "POST /api/meeting/read": (b) => { readMeeting(b.project, b.id, b.session); return { ok: true }; },
  "POST /api/fill": (b) => {
    const p = load(b.project); const t = p.tracks.find((x) => x.id === b.track);
    const s = b.session ? p.sessions.find((x) => x.id === b.session) : pickSession(p, b.track);
    if (!t || !s) throw Object.assign(new Error("Start a session on this track first."), { user: true });
    sendTo(p.id, s.id, fillPrompt(p, t)); return { session: s.id };
  },
};

function pickSession(p, track) {
  const liveMap = live();
  const ss = p.sessions.filter((s) => s.track === track);
  return ss.find((s) => runner.isRunning(s.id) || liveMap.get(s.id)) || ss[ss.length - 1];
}

function readMeeting(pid, mid, who) {
  const p = load(pid); const m = p.meetings.find((x) => x.id === mid);
  let s = who && who !== "auto" && who !== "new" ? p.sessions.find((x) => x.id === who) : null;
  if (!s && who !== "new") s = pickSession(p, m.track);
  if (!s) s = run("session.add", pid, { id: randomUUID(), track: m.track, name: "Read: " + m.title, cwd: expand(p.folder), started: false });
  run("meeting.set", pid, { id: mid, status: "reading", readBy: s.id });
  sendTo(pid, s.id, readMeetingPrompt(p, m));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.headers.host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host)) return json(res, 403, { error: "Local only." });
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": hi\n\n"); clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    // Attachments: the file's bytes are the body (no JSON), streamed to uploads/<project>/.
    if (req.method === "POST" && url.pathname === "/api/upload") return upload(req, res, url.searchParams);
    if (req.method === "POST" && url.pathname === "/api/voice") return voice(req, res);
    if (req.method === "GET" && url.pathname === "/api/leadfile") { // a lead's audit PDF, from the shared folder
      try { const l = leadsDb.get(url.searchParams.get("id")), a = (l.audits || [])[+url.searchParams.get("n")], f = a && expand(a.path);
        if (!f || !f.startsWith(join(SHARED, "sales") + "/") || f.includes("..") || !existsSync(f)) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${basename(f)}"` }); return createReadStream(f).pipe(res);
      } catch { res.writeHead(404); return res.end("Not found"); } }
    if (req.method === "POST" && url.pathname === "/api/logo") return saveLogo(req, res, url.searchParams);
    if (req.method === "GET" && url.pathname === "/api/file") return sendFile(res, url.searchParams.get("path"));
    if (req.method === "GET" && url.pathname.startsWith("/f/")) return viewFile(res, url.pathname);
    if (req.method === "GET" && url.pathname === "/api/thumb") return await thumb(res, url.searchParams);
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      if (req.method === "POST" && req.headers["content-type"] !== "application/json") return json(res, 415, { error: "JSON only." });
      const out = await route(req.method === "POST" ? await body(req) : url.searchParams);
      return json(res, 200, out);
    }
    if (req.method !== "GET") return json(res, 404, { error: "Not found." });
    let f = url.pathname === "/" ? "/index.html" : url.pathname;
    f = join(WEB, f.replace(/\.\.+/g, ""));
    if (!f.startsWith(WEB) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(f));
  } catch (e) {
    if (!e.user) console.error(e);
    json(res, e.user ? 400 : 500, { error: e.user ? e.message : "Something went wrong on the Desk. " + e.message });
  }
});

// Tracks made before every track got its own chat get one now (2 Nov 2026).
for (const p of loadAll()) if (p.tracks.some((t) => !p.sessions.some((s) => s.track === t.id))) try { update(p.id, (x) => ensureChats(x)); } catch {}
// Sales and the clients: synced with the other person's Desk every minute (lib/sync.mjs).
sync.start(() => { msgCache.clear(); broadcast({ type: "state" }); broadcast({ type: "leads" }); });
server.listen(PORT, "127.0.0.1", () => {
  // Replies that were running when the server last stopped carry on: pick them up again.
  const n = runner.resume((m) => { if (m.sid) streaming.set(m.sid, ""); return handler(m.project, m.sid, false); });
  console.log(`Desk is open at http://127.0.0.1:${PORT}` + (n ? ` (picked up ${n} ${n === 1 ? "reply" : "replies"} still running)` : ""));
});

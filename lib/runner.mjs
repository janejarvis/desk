// Talking to a session from the Desk: each message runs `claude -p` on that session (resume, or a
// fresh session id for a new one) in the session's own folder, and streams the reply back.
// A session that is also open in a terminal is continued as a copy (--fork-session), so the two
// never write into the same conversation; the Desk then follows the copy.
//
// Runs live OUTSIDE the server (30 Oct): each one is a detached process writing its stream to
// run/<job>.out, with a small run/<job>.json saying which session it belongs to. The server only
// reads those files, so it can restart at any time: a new server finds the runs still going and
// picks them up. "Is this session already busy?" is answered from the same files, so two replies
// can never run on one session at once.
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync, readSync, fstatSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME, ROOT, DESK_HOME } from "./store.mjs";
import { deskRules } from "./rules.mjs";
import { withShims } from "./accounts.mjs";

const RUN = process.env.DESK_RUN || join(DESK_HOME, "run"); // tests set their own, so they never pick up live replies
const running = new Map(); // any id the session has had during a run -> the run
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };


export const isRunning = (id) => running.has(id);
// Really working: a turn in progress, or a background helper (an agent) at work. A run kept open only for a
// background command (a preview server, a watcher) isn't: it shows as done (10 Nov 2026: chats finished hours ago
// still had the working arc because a dev server was left running).
export const isBusy = (id) => { const r = running.get(id); if (!r) return false; if (!r.idle) return true; return [...(r.open?.values() || [])].some((t) => t && t !== "local_bash"); };

const short = (s, n = 90) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const fname = (p) => String(p || "").split("/").pop();
function toolLine(c) {
  const i = c.input || {};
  switch (c.name) {
    case "Bash": return short(i.description || i.command);
    case "Read": return "Reading " + fname(i.file_path);
    case "Edit": case "MultiEdit": return "Editing " + fname(i.file_path);
    case "Write": return "Writing " + fname(i.file_path);
    case "Grep": return "Searching for " + short(i.pattern, 50);
    case "Glob": return "Looking for files " + short(i.pattern, 50);
    case "Agent": case "Task": return "Helper: " + short(i.description, 70);
    case "WebFetch": return "Reading " + short(i.url, 70);
    case "WebSearch": return "Searching the web: " + short(i.query, 60);
    default: return c.name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  }
}

// Messages waiting for a busy session are saved next to the run (run/<job>.queue), so a restart
// doesn't lose them. The server tells us how to turn a saved message back into a job.
let build = null; // (projectId, sessionId, text) -> { job, on }
export function onQueued(fn) { build = fn; }
const saveQueue = (e) => { try { if (e.queue.length) writeFileSync(join(RUN, e.m.jid + ".queue"), JSON.stringify(e.queue)); else unlinkSync(join(RUN, e.m.jid + ".queue")); } catch {} };

// send({ session, project, trackName, text, fork }, on) — on(event) gets
// { type: "start" } · { type: "queued" } · { type: "id", id } · { type: "message" } · { type: "delta", text } · { type: "tool", name } · { type: "done", error? }
export function send(job, on) {
  const r = running.get(job.session.id);
  // A message Diogo types while a question waits is the answer to it (as "other"). The Desk's own notes
  // (a background job ended, the morning run, a handover) never are: they wait their turn (6 Nov 2026).
  const fromDesk = job.auto || /^\[(From the Desk|Handed over|Morning run)/.test(String(job.text || ""));
  if (r?.question && !fromDesk) {
    answer(job.session.id, r.question.request_id, Object.fromEntries(r.question.questions.map((q) => [q.question, job.text])));
    return;
  }
  if (r) {
    r.queue.push({ project: job.project.id, text: job.text }); saveQueue(r);
    if (r.m.keeper && r.idle && !r.closing) nextTurn(r); // waiting on its helpers: the message goes straight in
    else on({ type: "queued" });
    return;
  }
  start(job, on);
}

// Which sign-in a reply uses (12 Nov 2026). The everyday sign-in, because Claude in Chrome only works with it (the
// long-lived key lacks the account scope Chrome needs: "OAuth token has no scope … user:profile"). When the everyday
// sign-in fails, the Desk marks it broken (data/claude-login.json), answers on the long-lived key meanwhile, and asks
// Diogo to sign in again; signing in clears the mark.
const LOGIN = join(DESK_HOME, "data", "claude-login.json");
export const loginBroken = () => { try { return !!JSON.parse(readFileSync(LOGIN, "utf8")).broken; } catch { return false; } };
export const setLoginBroken = (b) => { try { writeFileSync(LOGIN, JSON.stringify({ broken: !!b, at: new Date().toISOString() }) + "\n"); } catch {} };
// The Desk's own long-lived Claude key (bin/desk-claude-token.py, in the Keychain as "desk-claude-token"):
// replies use it instead of the everyday sign-in, which several programs renewing at once kept getting
// cancelled (8 Nov 2026: Diogo had to sign in again every morning). Without it, the usual sign-in is used.
let keyAt = 0, key = "";
export function deskKey() {
  if (process.platform !== "darwin" || process.env.DESK_CLAUDE_KEY === "off") return "";
  if (Date.now() - keyAt < 60e3) return key;
  keyAt = Date.now();
  try { key = execFileSync("security", ["find-generic-password", "-s", "desk-claude-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim(); } catch { key = ""; }
  return key;
}
function start(job, on) {
  const { session, project, trackName, text, fork } = job;
  mkdirSync(RUN, { recursive: true });
  const jid = randomUUID().slice(0, 12);
  // A run from the Desk can't stop and ask, so anything that would ask was refused. Diogo's call
  // (2 Nov 2026): Desk sessions may do everything without asking. DESK_PERMISSION_MODE overrides it.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", process.env.DESK_PERMISSION_MODE || "bypassPermissions", "--append-system-prompt", deskRules(project, session, { fromDesk: true })];
  // Claude in Chrome: on in Claude Code's own terminal, but a -p run only gets it with --chrome
  // (3 Nov 2026: the LQA chat couldn't reach Chrome although the extension was connected).
  if (process.env.DESK_CHROME !== "off") args.push("--chrome");
  if (session.started !== false) { args.push("--resume", session.id); if (fork) args.push("--fork-session"); }
  else args.push("--session-id", session.id);
  // claude.ai's own connectors (Gmail, Calendar, Drive) can't sign in inside a Desk run, so Claude Code
  // told every reply they "aren't connected" (2 Nov 2026). Off for Desk runs; DESK_CLAUDEAI_MCP=on brings them back.
  const env = { ...process.env, ...(process.env.DESK_CLAUDEAI_MCP === "on" ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }), DESK_PROJECT: project.id, DESK_TRACK: session.track, DESK_SESSION: session.id, PATH: withShims(project, [join(ROOT, "bin"), join(HOME, "bin"), join(HOME, ".local", "bin"), process.env.PATH || ""].join(delimiter)) };
  const useKey = !!deskKey() && (job.useKey || loginBroken());
  if (useKey) env.CLAUDE_CODE_OAUTH_TOKEN = deskKey();
  const out = openSync(join(RUN, jid + ".out"), "w"), err = openSync(join(RUN, jid + ".err"), "w");
  // Through bin/claude-keeper.mjs, which keeps Claude open while its helpers work (see there).
  const keeper = process.env.DESK_KEEPER !== "off";
  if (keeper) env.DESK_KEEPER_IN = join(RUN, jid + ".in");
  let child;
  try { child = keeper ? spawn(process.execPath, [join(ROOT, "bin", "claude-keeper.mjs"), process.env.DESK_CLAUDE || "claude", ...args], { cwd: session.cwd || HOME, env, detached: true, stdio: ["pipe", out, err] })
    : spawn(process.env.DESK_CLAUDE || "claude", args, { cwd: session.cwd || HOME, env, detached: true, stdio: ["pipe", out, err] }); }
  finally { closeSync(out); closeSync(err); }
  child.on("error", () => {}); // a failed start shows up below as a run that ended without a result
  child.stdin.on("error", () => {});
  child.stdin.end(text);
  child.unref();
  const m = { jid, sid: session.id, project: project.id, pid: child.pid, startedAt: new Date().toISOString(), keeper, useKey };
  writeFileSync(join(RUN, jid + ".json"), JSON.stringify(m));
  attach(m, on, job);
  on({ type: "start" });
}

// A keeper run is told what to do next through its .in file (bin/claude-keeper.mjs).
const tellKeeper = (e, o) => { try { appendFileSync(join(RUN, e.m.jid + ".in"), JSON.stringify(o) + "\n"); } catch {} };
// One turn of a keeper run has ended: the page gets "done" for it; then the next message waiting goes
// in, or the run waits for its helpers, or it is told to close.
function turnDone(e) {
  e.on({ type: "done", wrote: e.wrote || false });
  e.wrote = false; e.idle = true;
  nextTurn(e);
}
function nextTurn(e) {
  if (!e.idle || e.closing) return;
  const q = e.queue.shift();
  if (q) { saveQueue(e); e.idle = false; tellKeeper(e, { text: q.text }); e.on({ type: "start" }); return; }
  if (e.open?.size) return; // helpers still working: wait for them (their ending starts a turn by itself)
  e.closing = true; tellKeeper(e, { close: true });
}

// Follow a run through its output file until it ends. Used for new runs and, after a restart, for
// runs that were already going.
function attach(m, on, job) {
  let saved = []; try { saved = JSON.parse(readFileSync(join(RUN, m.jid + ".queue"), "utf8")); } catch {}
  const e = { m, on, queue: saved, ids: new Set([m.sid]), id: m.sid, off: 0, buf: "", ended: false, idSeen: false, job };
  for (const id of e.ids) running.set(id, e);
  const outPath = join(RUN, m.jid + ".out");
  const tick = () => {
    if (e.ended) return;
    try {
      const fd = openSync(outPath, "r");
      try {
        const size = fstatSync(fd).size;
        if (size > e.off) { const b = Buffer.alloc(size - e.off); readSync(fd, b, 0, b.length, e.off); e.off = size; e.buf += b.toString("utf8"); }
      } finally { closeSync(fd); }
    } catch {}
    let i;
    while ((i = e.buf.indexOf("\n")) >= 0) {
      const line = e.buf.slice(0, i); e.buf = e.buf.slice(i + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "system" && o.subtype === "init" && o.session_id && !e.idSeen) {
        e.idSeen = true;
        if (o.session_id !== e.id) { e.id = o.session_id; e.ids.add(e.id); running.set(e.id, e); e.on({ type: "id", id: e.id }); }
      } else if (o.type === "stream_event" && o.parent_tool_use_id == null) {
        const ev = o.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { e.wrote = true; e.on({ type: "delta", text: ev.delta.text }); }
        if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") e.on({ type: "thinking" });
        if (ev?.type === "message_start") { if (e.idle && !e.closing) { e.idle = false; e.on({ type: "start" }); } e.on({ type: "message" }); }
      } else if (o.type === "assistant" && o.parent_tool_use_id == null && Array.isArray(o.message?.content)) {
        // The full tool call: say in plain words what it is doing (Claude writes a description for
        // most commands), so a long step reads as work, not as a frozen pane.
        for (const c of o.message.content) if (c?.type === "tool_use") e.on({ type: "tool", name: c.name, detail: toolLine(c) });
      } else if (o.type === "user" && Array.isArray(o.message?.content)) {
        // A step a hook refused (one of Diogo's own safety rules, e.g. "no git add -A") isn't a
        // question for her: Claude reads the reason and does it another way. Note it, so it isn't
        // shown as "needs your OK" (2 Nov 2026: "why am I still receiving these?").
        // The question's own result: it was answered (also when this run is read again after a restart).
        if (e.question?.tool_use_id && o.message.content.some((c) => c?.type === "tool_result" && c.tool_use_id === e.question.tool_use_id)) { (e.answered ||= new Set()).add(e.question.request_id); e.question = null; e.on({ type: "answered" }); }
        for (const c of o.message.content) if (c?.type === "tool_result" && /hook error|hook blocked|REFUSED/i.test(typeof c.content === "string" ? c.content : JSON.stringify(c.content || ""))) (e.hooked ||= new Set()).add(c.tool_use_id);
      } else if (o.type === "control_request" && o.request?.tool_name === "AskUserQuestion") {
        // Claude asks Diogo something with choices: the Desk shows buttons (bin/claude-keeper.mjs waits).
        if (!e.answered?.has(o.request_id)) { e.question = { request_id: o.request_id, tool_use_id: o.request.tool_use_id || "", questions: o.request.input?.questions || [], at: new Date().toISOString() }; e.on({ type: "question", question: e.question }); }
      } else if (o.type === "system" && o.subtype === "task_started" && o.task_id) {
        // Only what really runs in the background keeps the reply open (a foreground command is part of the turn).
        if (o.is_backgrounded !== false) { (e.tasks ||= new Map()).set(o.task_id, o.description || "a background job"); (e.open ||= new Map()).set(o.task_id, o.task_type || ""); }
      } else if (o.type === "system" && o.subtype === "task_notification" && o.task_id && e.tasks?.has(o.task_id)) {
        // A helper or background command started in this run and stopped (not completed) is one the
        // end of the reply cut off (3 Nov 2026: the PWA chat's build kept being "interrupted").
        if (o.status === "stopped") (e.cutOff ||= new Map()).set(o.task_id, e.tasks.get(o.task_id));
        else e.cutOff?.delete(o.task_id);
        e.open?.delete(o.task_id);
      } else if (o.type === "result" && !o.is_error && !o.result && !o.num_turns) {
        // An empty turn before the real one: on resume, Claude Code first hands over a note about a
        // background job that ended, answers it with nothing, and only then reads the message. Ending
        // here showed "finished without writing a reply" and cut the real reply off (3 Nov 2026).
        // If the run then really ends, that empty turn was all there was: it ends cleanly, below.
        e.emptyTurn = true; continue;
      } else if (o.type === "result") {
        const denied = (o.permission_denials || []).filter((d) => !e.hooked?.has(d.tool_use_id)).map((d) => ({ tool: d.tool_name, detail: toolLine({ name: d.tool_name, input: d.tool_input }), command: d.tool_name === "Bash" ? d.tool_input?.command || "" : "" }));
        // Desk runs may do everything (bypassPermissions), so a refusal can only be one of the project's
        // own safety rules (a "deny" in its .claude/settings.json, e.g. UrgentPlumber's "no --force").
        // That isn't a question for Diogo: Claude reads it and finds a safe way (3 Nov 2026: a card
        // asked him to "Run it myself (!)" for a forced delete his rules exist to stop).
        if (denied.length && (process.env.DESK_PERMISSION_MODE || "bypassPermissions") !== "bypassPermissions") e.on({ type: "denied", items: denied });
        if (!e.m.keeper) return finish(e, o.is_error ? (o.result || "Claude stopped with an error.") : undefined);
        if (o.is_error) { e.closing = true; tellKeeper(e, { close: true }); return finish(e, o.result || "Claude stopped with an error."); }
        turnDone(e); continue;
      }
    }
    if (!alive(m.pid)) {
      if (e.m.keeper && e.idle) return finish(e, undefined, { quiet: true }); // every turn already reported
      if (e.emptyTurn) return finish(e);
      let msg = "Claude stopped before it finished.";
      try { const t = readFileSync(join(RUN, m.jid + ".err"), "utf8").trim().split("\n").pop(); if (t) msg = t; } catch {}
      finish(e, msg);
    }
  };
  e.timer = setInterval(tick, 250);
  tick();
}

function finish(e, error, { quiet = false } = {}) {
  if (e.ended) return; e.ended = true;
  clearInterval(e.timer);
  for (const id of e.ids) running.delete(id);
  // Keep the run's raw output (run/done/, last 40) so a strange ending can be looked at afterwards.
  try { mkdirSync(join(RUN, "done"), { recursive: true }); writeFileSync(join(RUN, "done", e.m.jid + ".json"), JSON.stringify({ ...e.m, endedAt: new Date().toISOString(), error: error || null })); renameSync(join(RUN, e.m.jid + ".out"), join(RUN, "done", e.m.jid + ".out")); } catch {}
  try { const old = readdirSync(join(RUN, "done")).filter((f) => f.endsWith(".json")).sort((a, b) => statSync(join(RUN, "done", a)).mtimeMs - statSync(join(RUN, "done", b)).mtimeMs); for (const f of old.slice(0, Math.max(0, old.length - 40))) for (const x of [".json", ".out"]) try { unlinkSync(join(RUN, "done", f.replace(".json", x))); } catch {} } catch {}
  // .in stays while the process lives: it may not have read its "close" yet (the keeper removes it).
  for (const x of [".out", ".err", ".json", ".queue", ...(alive(e.m.pid) ? [] : [".in"])]) try { unlinkSync(join(RUN, e.m.jid + x)); } catch {}
  const cutOff = [...(e.cutOff?.values() || [])];
  if (!quiet) e.on({ type: "done", error, wrote: e.wrote || false, cutOff, usedKey: !!e.m.useKey });
  else if (cutOff.length) e.on({ type: "cutoff", cutOff });
  // Messages typed while it was working go next, in order, to the same (possibly new) session id.
  const [first, ...more] = e.queue;
  if (first && build) {
    let next; try { next = build(first.project, e.id, first.text); } catch {}
    if (next) { start(next.job, next.on); const r = running.get(e.id); if (r && more.length) { r.queue.push(...more); saveQueue(r); } }
  }
}

// After a server restart: pick up runs that are still going (and close out ones that ended while
// no server was watching). makeOn(manifest) gives the event handler for that run's session.
export function resume(makeOn) {
  let files = []; try { files = readdirSync(RUN).filter((f) => /^[0-9a-f-]{12}\.json$/.test(f)); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    let m; try { m = JSON.parse(readFileSync(join(RUN, f), "utf8")); } catch { continue; }
    if (!existsSync(join(RUN, m.jid + ".out"))) { try { unlinkSync(join(RUN, f)); } catch {} continue; }
    attach(m, makeOn(m), null); n++;
  }
  return n;
}

// Diogo's answer to a question (request_id) of a running session: { "<question>": "<label(s)>" }.
export function answer(id, request_id, answers) {
  const r = running.get(id);
  if (!r?.question || r.question.request_id !== request_id) return false;
  tellKeeper(r, { answer: { request_id, answers } });
  (r.answered ||= new Set()).add(request_id); r.question = null; r.on({ type: "answered", request_id });
  return true;
}
export const questionOf = (id) => running.get(id)?.question || null;
export function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  r.queue = [];
  // The run is its own process group (detached): stop all of it, not just the launcher.
  try { process.kill(-r.m.pid, "SIGINT"); } catch { try { process.kill(r.m.pid, "SIGINT"); } catch {} }
  setTimeout(() => { try { process.kill(-r.m.pid, "SIGKILL"); } catch {} }, 4000);
  return true;
}

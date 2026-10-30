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
import { spawn } from "node:child_process";
import { openSync, closeSync, readSync, fstatSync, readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME, ROOT } from "./store.mjs";
import { deskRules } from "./rules.mjs";

const RUN = join(ROOT, "run");
const running = new Map(); // any id the session has had during a run -> the run
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };


export const isRunning = (id) => running.has(id);

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
  if (r) { r.queue.push({ project: job.project.id, text: job.text }); saveQueue(r); on({ type: "queued" }); return; }
  start(job, on);
}

function start(job, on) {
  const { session, project, trackName, text, fork } = job;
  mkdirSync(RUN, { recursive: true });
  const jid = randomUUID().slice(0, 12);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--append-system-prompt", deskRules(project, session, { fromDesk: true })];
  if (session.started !== false) { args.push("--resume", session.id); if (fork) args.push("--fork-session"); }
  else args.push("--session-id", session.id);
  const env = { ...process.env, DESK_PROJECT: project.id, DESK_TRACK: session.track, DESK_SESSION: session.id, PATH: `${join(ROOT, "bin")}:${join(HOME, "bin")}:${join(HOME, ".local", "bin")}:${process.env.PATH || ""}` };
  const out = openSync(join(RUN, jid + ".out"), "w"), err = openSync(join(RUN, jid + ".err"), "w");
  let child;
  try { child = spawn(process.env.DESK_CLAUDE || "claude", args, { cwd: session.cwd || HOME, env, detached: true, stdio: ["pipe", out, err] }); }
  finally { closeSync(out); closeSync(err); }
  child.on("error", () => {}); // a failed start shows up below as a run that ended without a result
  child.stdin.on("error", () => {});
  child.stdin.end(text);
  child.unref();
  const m = { jid, sid: session.id, project: project.id, pid: child.pid, startedAt: new Date().toISOString() };
  writeFileSync(join(RUN, jid + ".json"), JSON.stringify(m));
  attach(m, on, job);
  on({ type: "start" });
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
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") e.on({ type: "delta", text: ev.delta.text });
        if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") e.on({ type: "thinking" });
        if (ev?.type === "message_start") e.on({ type: "message" });
      } else if (o.type === "assistant" && o.parent_tool_use_id == null && Array.isArray(o.message?.content)) {
        // The full tool call: say in plain words what it is doing (Claude writes a description for
        // most commands), so a long step reads as work, not as a frozen pane.
        for (const c of o.message.content) if (c?.type === "tool_use") e.on({ type: "tool", name: c.name, detail: toolLine(c) });
      } else if (o.type === "result") {
        const denied = (o.permission_denials || []).map((d) => ({ tool: d.tool_name, detail: toolLine({ name: d.tool_name, input: d.tool_input }), command: d.tool_name === "Bash" ? d.tool_input?.command || "" : "" }));
        if (denied.length) e.on({ type: "denied", items: denied });
        return finish(e, o.is_error ? (o.result || "Claude stopped with an error.") : undefined);
      }
    }
    if (!alive(m.pid)) {
      let msg = "Claude stopped before it finished.";
      try { const t = readFileSync(join(RUN, m.jid + ".err"), "utf8").trim().split("\n").pop(); if (t) msg = t; } catch {}
      finish(e, msg);
    }
  };
  e.timer = setInterval(tick, 250);
  tick();
}

function finish(e, error) {
  if (e.ended) return; e.ended = true;
  clearInterval(e.timer);
  for (const id of e.ids) running.delete(id);
  for (const x of [".out", ".err", ".json", ".queue"]) try { unlinkSync(join(RUN, e.m.jid + x)); } catch {}
  e.on({ type: "done", error });
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

export function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  r.queue = [];
  // The run is its own process group (detached): stop all of it, not just the launcher.
  try { process.kill(-r.m.pid, "SIGINT"); } catch { try { process.kill(r.m.pid, "SIGINT"); } catch {} }
  setTimeout(() => { try { process.kill(-r.m.pid, "SIGKILL"); } catch {} }, 4000);
  return true;
}

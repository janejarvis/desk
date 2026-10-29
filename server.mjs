#!/usr/bin/env node
// Jane's Desk — a local app for her projects: chats with Claude sessions, roadmaps, the board and
// meeting transcripts. 127.0.0.1 only. Data: data/projects/*.json (see lib/store.mjs).
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, watch, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, DATA, expand, tilde, load, loadAll } from "./lib/store.mjs";
import { run } from "./lib/ops.mjs";
import { messages, lastWrite, live } from "./lib/sessions.mjs";
import * as runner from "./lib/runner.mjs";

const PORT = +(process.env.DESK_PORT || 4747);
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
  const at = lastWrite(s.id, s.cwd);
  const c = msgCache.get(s.id);
  if (c && c.at === at) return c.msgs;
  const msgs = messages(s.id, s.cwd);
  msgCache.set(s.id, { at, msgs });
  return msgs;
}

function sessionView(s, liveMap) {
  const l = liveMap.get(s.id);
  const msgs = s.started === false ? [] : convo(s);
  const last = msgs[msgs.length - 1];
  const lastAt = last ? Date.parse(last.at) || 0 : 0;
  let state = "idle";
  if (runner.isRunning(s.id) || l?.status === "busy") state = "working";
  else if (last?.who === "claude" && lastAt > (Date.parse(s.seenAt || "") || 0) && Date.now() - lastAt < 3 * 864e5) state = "waiting";
  return { ...s, cwd: tilde(s.cwd), state, terminal: !!l?.interactive, lastAt, last: last ? { who: last.who, text: last.text.slice(0, 220), at: last.at } : null };
}

function state() {
  const liveMap = live();
  return { projects: loadAll().map((p) => ({ ...p, folder: tilde(p.folder), sessions: p.sessions.map((s) => sessionView(s, liveMap)) })) };
}

// Tell open pages when anything changes: a project file, a session's transcript, a session going busy.
let sig = "";
function check() {
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

// ---- sending a message to a session ----
function sendTo(pid, sid, text) {
  const p = load(pid);
  const s = p.sessions.find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error("That session isn't on the desk any more."), { user: true });
  const fork = s.started !== false && !!live().get(s.id)?.interactive;
  let cur = s.id;
  runner.send({ session: { ...s, cwd: expand(s.cwd) }, project: p, trackName: p.tracks.find((t) => t.id === s.track)?.name || "", text, fork }, (ev) => {
    if (ev.type === "start") { streaming.set(cur, ""); if (s.started === false) run("session.set", pid, { id: cur, started: true }); }
    if (ev.type === "id") { const old = cur; cur = ev.id; streaming.set(cur, streaming.get(old) || ""); streaming.delete(old); run("session.set", pid, { id: old, newId: cur }); broadcast({ type: "renamed", from: old, to: cur }); return; }
    if (ev.type === "delta") streaming.set(cur, (streaming.get(cur) || "") + ev.text);
    if (ev.type === "message") { const t = streaming.get(cur); if (t && !t.endsWith("\n\n")) streaming.set(cur, t + "\n\n"); }
    if (ev.type === "done") { streaming.delete(cur); msgCache.delete(cur); if (ev.error && s.started === false) run("session.set", pid, { id: cur, started: false }); }
    broadcast({ ...ev, type: "stream", kind: ev.type, session: cur });
    if (ev.type === "done" || ev.type === "start") check();
  });
}

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "meeting";

function readMeetingPrompt(p, m) {
  const path = join(expand(p.transcripts), m.file);
  return [
    `Please read the meeting transcript at ${path} (${p.name} · ${p.tracks.find((t) => t.id === m.track)?.name}; meeting "${m.title}", ${m.date}).`,
    `Then record what you found with one command:`,
    `desk meeting done ${m.id} --summary "<2 to 4 plain sentences>" --action "<action>" --action "<action>"`,
    `One --action per thing someone has to do, in plain English, naming the person when it isn't you. Don't put them on the board yourself: Jane picks which ones go there. Then reply with the summary.`,
  ].join("\n");
}

const fillPrompt = (p, t) => [
  `Jane's Desk shows a roadmap and a board for ${p.name} · ${t.name}, and they're empty or out of date. From what you know about this work (this conversation, the project's plan and notes), set them up with the desk command:`,
  `1. The track's milestones in order: \`desk milestone add "<title>" --status done|now|next\` (add --due YYYY-MM-DD only for a real date). Usually 3 to 6; exactly one "now".`,
  `2. The open to-dos under the right milestone with their real status: doing, blocked (--why), waiting (--waiting <name>), sent (--to <name>), or todo. Recently finished ones as done.`,
  `Only real work you know about; don't invent dates or tasks. Run \`desk status\` first so you don't duplicate anything. Reply with two lines on what you set up.`,
].join("\n");

// ---- HTTP ----
async function body(req) {
  let b = ""; for await (const c of req) { b += c; if (b.length > 5e6) throw Object.assign(new Error("That's too large."), { user: true }); }
  try { return JSON.parse(b || "{}"); } catch { throw Object.assign(new Error("Bad request."), { user: true }); }
}
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const routes = {
  "GET /api/state": () => state(),
  "GET /api/messages": (q) => {
    const p = load(q.get("project")); const s = p.sessions.find((x) => x.id === q.get("session"));
    if (!s) return { messages: [] };
    return { messages: s.started === false ? [] : convo(s), streaming: streaming.get(s.id) ?? null };
  },
  "GET /api/transcript": (q) => {
    const p = load(q.get("project")); const m = p.meetings.find((x) => x.id === q.get("id"));
    if (!m) return { text: "" };
    try { return { text: readFileSync(join(expand(p.transcripts), m.file), "utf8").slice(0, 200000) }; } catch { return { text: "(The file isn't there any more.)" }; }
  },
  "POST /api/op": (b) => ({ result: run(b.op, b.project, b) }),
  "POST /api/send": (b) => { if (!String(b.text || "").trim()) throw Object.assign(new Error("Type a message first."), { user: true }); sendTo(b.project, b.session, String(b.text)); return { ok: true }; },
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
    if (b.docx) { // a Word file: keep it, and read its text with macOS's textutil
      docx = Buffer.from(String(b.docx), "base64");
      const tmp = join(tmpdir(), `desk-${randomUUID()}.docx`); writeFileSync(tmp, docx);
      try { b.text = execFileSync("textutil", ["-convert", "txt", "-stdout", tmp], { encoding: "utf8", maxBuffer: 50e6 }); }
      catch { throw Object.assign(new Error("Couldn't read that Word file. Try pasting its text instead."), { user: true }); }
      finally { try { unlinkSync(tmp); } catch {} }
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

server.listen(PORT, "127.0.0.1", () => console.log(`Desk is open at http://127.0.0.1:${PORT}`));

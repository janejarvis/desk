// Every change to a project, in one place: the page (through the server) and the `desk` command
// (which sessions run) both come through here, so the rules are the same for both.
import { update, load, loadAll, expand, create, listIds, DESK_HOME, ME, tilde, SHARED } from "./store.mjs";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { existsSync } from "node:fs";
import { kindOf, titleFor } from "./files.mjs";
import { randomUUID } from "node:crypto";

// Every track has a chat ready to type in (Diogo, 2 Nov 2026: a new project's tracks showed no chat
// windows). It is a session that starts with its first message, in the project's folder.
function chatFor(p, t) { return { id: randomUUID(), track: t.id, name: t.name, cwd: expand(p.folder), createdAt: now(), started: false, ...(p.shared ? { owner: ME } : {}) }; }
export function ensureChats(p) { if (p.kind === "sales") return 0; let n = 0; for (const t of p.tracks) if (!p.sessions.some((s) => s.track === t.id)) { p.sessions.push(chatFor(p, t)); n++; } return n; }

// "ongoing": a standing duty that is never finished (e.g. log a client's hours for the monthly report);
// it repeats every day / week / month and is ticked off each time it is done.
export const STATUSES = ["ongoing", "todo", "doing", "blocked", "waiting", "sent", "done"];
export const EVERY = ["daily", "weekly", "monthly"];
export const MS_STATES = ["done", "now", "next"];
const now = () => new Date().toISOString();
const rid = (p) => p + Math.random().toString(36).slice(2, 8);
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = (s, max = 300) => String(s ?? "").trim().slice(0, max);

function fail(msg) { throw Object.assign(new Error(msg), { user: true }); }

// Find a project by id or name (case-insensitive).
export function projectId(q) {
  const k = String(q || "").toLowerCase();
  const p = loadAll().find((x) => x.id === k || x.name.toLowerCase() === k);
  if (!p) fail(`No project called "${q}". Projects: ${loadAll().map((x) => x.name).join(", ")}.`);
  return p.id;
}
// Find a track by id or name.
export function trackOf(p, q) {
  if (!q) return p.tracks[0].id;
  const k = String(q).toLowerCase();
  const t = p.tracks.find((x) => x.id === k || x.name.toLowerCase() === k);
  if (!t) fail(`${p.name} has no track "${q}". Tracks: ${p.tracks.map((x) => x.name).join(", ")}.`);
  return t.id;
}
function findIn(p, list, id, what) {
  const x = p[list].find((y) => y.id === id);
  if (!x) fail(`No ${what} ${id} in ${p.name}.`);
  return x;
}
// Which project holds a to-do / milestone / meeting / session with this id.
export function ownerOf(list, id) {
  const p = loadAll().find((x) => (x[list] || []).some((y) => y.id === id));
  if (!p) fail(`Nothing with id ${id}.`);
  return p.id;
}

function applyTodo(t, f) {
  if (f.title !== undefined) t.title = clean(f.title, 200) || t.title;
  if (f.priority !== undefined) t.priority = [1, 2, 3].includes(+f.priority) ? +f.priority : 2;
  if (f.due !== undefined) { if (f.due && !isDate(f.due)) fail("Dates are YYYY-MM-DD."); t.due = f.due || ""; }
  if (f.owner !== undefined) t.owner = clean(f.owner, 40);
  if (f.note !== undefined) t.note = clean(f.note, 2000);
  if (f.why !== undefined) t.why = clean(f.why, 200);
  if (f.waitingOn !== undefined) t.waitingOn = clean(f.waitingOn, 40);
  if (f.sentTo !== undefined) t.sentTo = clean(f.sentTo, 40);
  if (f.milestone !== undefined) t.milestone = f.milestone || "";
  if (f.every !== undefined) { if (f.every && !EVERY.includes(f.every)) fail(`Every is one of: ${EVERY.join(", ")}.`); t.every = f.every; }
  if (f.lastDone !== undefined) t.lastDone = f.lastDone;
  if (f.status !== undefined && f.status !== t.status) {
    if (!STATUSES.includes(f.status)) fail(`Status is one of: ${STATUSES.join(", ")}.`);
    t.status = f.status;
    if (f.status !== "blocked" && f.why === undefined) t.why = "";
    if (f.status === "done") t.doneAt = now(); else delete t.doneAt;
    if (f.status === "sent") t.sentAt = now();
    if (f.status === "waiting" && !t.waitingOn) t.waitingOn = ME;
    if (f.status === "ongoing" && !t.every) t.every = "weekly";
  }
  t.updatedAt = now();
}

export const ops = {
  // ---- to-dos ----
  "todo.add"(pid, f) {
    return update(pid, (p) => {
      const track = trackOf(p, f.track);
      const title = clean(f.title, 200); if (!title) fail("A to-do needs a title.");
      const milestone = f.status === "ongoing" ? "" : f.milestone || p.milestones.find((m) => m.track === track && m.status === "now")?.id || "";
      const t = { id: rid("t"), track, milestone, title, status: "todo", priority: 2, due: "", owner: "", waitingOn: "", note: "", createdAt: now(), source: f.source || "page" };
      applyTodo(t, { ...f, title: undefined, milestone: undefined, status: f.status || (f.waitingOn ? "waiting" : "todo") });
      p.todos.push(t);
      return t;
    });
  },
  "todo.set"(pid, f) {
    return update(pid, (p) => { const t = findIn(p, "todos", f.id, "to-do"); if (f.track) t.track = trackOf(p, f.track); applyTodo(t, f); return t; });
  },
  "todo.tick"(pid, f) {
    // An ongoing duty was done again: note when, so the board knows when it's next due.
    return update(pid, (p) => { const t = findIn(p, "todos", f.id, "to-do"); t.lastDone = now(); t.updatedAt = t.lastDone; return t; });
  },
  "todo.remove"(pid, f) {
    return update(pid, (p) => { findIn(p, "todos", f.id, "to-do"); p.todos = p.todos.filter((t) => t.id !== f.id); });
  },

  "project.set"(pid, f) {
    return update(pid, (p) => { if (f.logo !== undefined) p.logo = f.logo; if (f.color && /^#[0-9a-f]{6}$/i.test(f.color)) p.color = f.color; if (f.name) p.name = clean(f.name, 40) || p.name;
      if (f.account) { const [tool, name] = f.account; p.accounts = { ...(p.accounts || {}) }; if (name) p.accounts[tool] = String(name).trim().slice(0, 40); else delete p.accounts[tool]; if (!Object.keys(p.accounts).length) delete p.accounts; }
      return p; });
  },

  // ---- tracks ----
  "track.add"(pid, f) {
    return update(pid, (p) => {
      const name = clean(f.name, 28) || "New track";
      let id = slug(name) || "track"; while (p.tracks.some((t) => t.id === id)) id += "-2";
      const t = { id, name }; p.tracks.push(t); p.sessions.push(chatFor(p, t)); return t;
    });
  },
  "track.rename"(pid, f) {
    return update(pid, (p) => { const t = p.tracks.find((x) => x.id === f.id); if (!t) fail("No such track."); t.name = clean(f.name, 28) || t.name; return t; });
  },

  // ---- milestones ----
  "milestone.add"(pid, f) {
    return update(pid, (p) => {
      const title = clean(f.title, 120); if (!title) fail("A milestone needs a title.");
      if (f.due && !isDate(f.due)) fail("Dates are YYYY-MM-DD.");
      const m = { id: rid("m"), track: trackOf(p, f.track), title, due: f.due || "", status: MS_STATES.includes(f.status) ? f.status : "next", note: clean(f.note, 1000) };
      // Keep a track's milestones in order: insert before the first later-dated one.
      const i = m.due ? p.milestones.findIndex((x) => x.track === m.track && x.due && x.due > m.due) : -1;
      if (i < 0) p.milestones.push(m); else p.milestones.splice(i, 0, m);
      return m;
    });
  },
  "milestone.set"(pid, f) {
    return update(pid, (p) => {
      const m = findIn(p, "milestones", f.id, "milestone");
      if (f.title !== undefined) m.title = clean(f.title, 120) || m.title;
      if (f.due !== undefined) { if (f.due && !isDate(f.due)) fail("Dates are YYYY-MM-DD."); m.due = f.due; }
      if (f.note !== undefined) m.note = clean(f.note, 1000);
      if (f.status !== undefined) {
        if (!MS_STATES.includes(f.status)) fail(`Milestone status is one of: ${MS_STATES.join(", ")}.`);
        m.status = f.status;
        if (f.status === "done") m.doneAt = now();
      }
      return m;
    });
  },
  "milestone.remove"(pid, f) {
    return update(pid, (p) => { findIn(p, "milestones", f.id, "milestone"); p.milestones = p.milestones.filter((m) => m.id !== f.id); for (const t of p.todos) if (t.milestone === f.id) t.milestone = ""; });
  },

  // ---- numbers (the Numbers tab): what a project's sessions track, one value per key ----
  "metric.set"(pid, f) {
    const key = clean(f.key, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!key) fail("Give the number a short name, e.g. reach or posts-this-month.");
    if (f.value === undefined || String(f.value).trim() === "") fail("Give it a value.");
    return update(pid, (p) => {
      p.metrics ||= [];
      let m = p.metrics.find((x) => x.key === key);
      if (!m) { m = { key, label: clean(f.label, 60) || key.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) }; p.metrics.push(m); }
      if (f.label) m.label = clean(f.label, 60);
      m.value = clean(f.value, 40); m.note = f.note !== undefined ? clean(f.note, 160) : m.note || ""; m.at = now(); m.by = ME;
      if (f.target !== undefined) m.target = clean(f.target, 40);
      if (f.better === "up" || f.better === "down") m.better = f.better;
      if (f.group !== undefined) m.group = clean(f.group, 40);
      // f.at: a past figure (backfill), kept in the history in date order; the shown value stays the newest
      const at = f.at && !isNaN(Date.parse(f.at)) ? new Date(f.at).toISOString() : m.at;
      (m.history ||= []).push({ at, value: m.value }); m.history.sort((a, b) => a.at.localeCompare(b.at));
      if (m.history.length > 60) m.history.splice(0, m.history.length - 60);
      const last = m.history[m.history.length - 1]; m.value = last.value;
      return m;
    });
  },
  "metric.remove"(pid, f) {
    return update(pid, (p) => { const n = (p.metrics || []).length; p.metrics = (p.metrics || []).filter((m) => m.key !== f.key); if (p.metrics.length === n) fail(`No number called ${f.key}.`); });
  },

  // ---- sessions ----
  "session.add"(pid, f) {
    return update(pid, (p) => {
      if (p.sessions.some((s) => s.id === f.id)) fail("That session is already on the desk.");
      const s = { id: f.id, track: trackOf(p, f.track), name: clean(f.name, 40) || "New session", cwd: f.cwd, createdAt: now(), started: f.started !== false, ...(p.shared ? { owner: ME } : {}) };
      p.sessions.push(s); return s;
    });
  },
  "session.set"(pid, f) {
    return update(pid, (p) => {
      const s = findIn(p, "sessions", f.id, "session");
      if (f.name !== undefined) s.name = clean(f.name, 40) || s.name;
      if (f.track !== undefined) s.track = trackOf(p, f.track);
      if (f.seenAt !== undefined) s.seenAt = f.seenAt;
      if (f.started !== undefined) s.started = !!f.started;
      if (f.pendingShell !== undefined) s.pendingShell = f.pendingShell;
      if (f.denied !== undefined) s.denied = f.denied;
      if (f.bg !== undefined) { if (f.bg.length) s.bg = f.bg; else delete s.bg; }
      if (f.asks !== undefined) { if (f.asks.length) s.asks = f.asks; else delete s.asks; }
      if (f.addDenied) s.denied = [...(s.denied || []), ...f.addDenied].slice(-20);
      if (f.newId) {
        for (const m of p.meetings) if (m.readBy === s.id) m.readBy = f.newId; // keep "who is reading it" pointing at the session
        s.previousIds = [...(s.previousIds || []), s.id]; s.id = f.newId;
      }
      return s;
    });
  },
  "session.remove"(pid, f) {
    return update(pid, (p) => { p.sessions = p.sessions.filter((s) => s.id !== f.id); });
  },

  // ---- files Claude made (the Files tab) ----
  "file.add"(pid, f) {
    const where = String(f.path || f.url || "").trim();
    const isUrl = /^https:\/\/claude\.ai\/(code\/)?artifact\//.test(where);
    const path = isUrl ? "" : expand(where);
    if (!isUrl && !(isAbsolute(path) && existsSync(path))) fail(`No file at ${where}. Give the full path of a file that exists, or a claude.ai artifact link.`);
    // A shared project's files are copied into the shared folder, so the other person has them too.
    if (!isUrl && load(pid).shared && !path.startsWith(SHARED + "/")) {
      const dir = join(SHARED, "files", pid); mkdirSync(dir, { recursive: true });
      const to = join(dir, basename(path)); copyFileSync(path, to); f = { ...f, path: to };
      return ops["file.add"](pid, f);
    }
    return update(pid, (p) => {
      p.files ||= [];
      const at = f.at || now();
      const same = p.files.find((x) => (isUrl ? x.url === where : x.path === path));
      const track = f.track ? trackOf(p, f.track) : p.sessions.find((s) => s.id === f.session || (s.previousIds || []).includes(f.session))?.track || same?.track || p.tracks[0].id;
      if (same) { // made again or republished: keep one card, newest details
        Object.assign(same, { title: clean(f.title, 120) || same.title, at: at > same.at ? at : same.at, session: f.session || same.session, track });
        return same;
      }
      const x = { id: rid("f"), kind: kindOf(where), title: clean(f.title, 120) || (isUrl ? "Artifact" : titleFor(path)), track, session: f.session || "", at, source: f.source || "claude", note: clean(f.note, 300) };
      if (isUrl) x.url = where; else x.path = path;
      p.files.push(x);
      return x;
    });
  },
  "file.remove"(pid, f) {
    return update(pid, (p) => { p.files = (p.files || []).filter((x) => x.id !== f.id); });
  },

  // ---- meetings ----
  "meeting.add"(pid, f) {
    return update(pid, (p) => {
      const m = { id: rid("mt"), track: trackOf(p, f.track), title: clean(f.title, 80) || "Meeting", date: isDate(f.date) ? f.date : new Date().toISOString().slice(0, 10), file: f.file, status: "new", summary: "", actions: [], createdAt: now() };
      p.meetings.push(m); return m;
    });
  },
  "meeting.set"(pid, f) {
    return update(pid, (p) => {
      const m = findIn(p, "meetings", f.id, "meeting");
      for (const k of ["status", "readBy", "title"]) if (f[k] !== undefined) m[k] = f[k];
      if (f.summary !== undefined) m.summary = clean(f.summary, 4000);
      if (f.actions !== undefined) m.actions = f.actions.map((a) => typeof a === "string" ? { title: clean(a, 200), added: false } : a);
      return m;
    });
  },
  "meeting.addAction"(pid, f) {
    // Put one of a meeting's actions on the board as a to-do, noting where it came from.
    const mt = load(pid).meetings.find((m) => m.id === f.id); if (!mt) fail("No such meeting.");
    const a = mt.actions[f.index]; if (!a || a.added) return null;
    const t = ops["todo.add"](pid, { title: a.title, track: mt.track, note: `From the meeting “${mt.title}”, ${mt.date}.`, source: "meeting" });
    update(pid, (p) => { p.meetings.find((m) => m.id === f.id).actions[f.index].added = t.id; });
    return t;
  },
};

// ---- projects ----
const PALETTE = ["#7c3aed", "#0071e3", "#9a7633", "#0f766e", "#d93025", "#ea8a00", "#db2777", "#4f46e5", "#16a34a", "#475569"];
// Every project has a brief: who the client is, the people, decisions, where things live. Sessions
// read it when they start and keep it current. Projects without their own get one under briefs/.
export function briefTemplate(name) {
  return `# ${name} — project brief\n\nRead this first when you start work on ${name}. Keep it current: when you learn something a new session would need, add it here.\n\n## What this is\n\n## People\n\n## How we work with them\n\n## Decisions so far\n\n## Where things live\n(folders, repos, sites, accounts — never passwords)\n\n## Open questions\n`;
}
export function ensureBrief(p) {
  if (p.brief) return p.brief;
  // A shared project's brief is shared too (both people's sessions read and keep the same one).
  const dir = p.shared ? join(SHARED, "briefs") : join(DESK_HOME, "briefs"), path = join(dir, p.id + ".md");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, briefTemplate(p.name));
  const keep = p.shared ? "shared:briefs/" + p.id + ".md" : tilde(path);
  update(p.id, (q) => { q.brief = keep; });
  return keep;
}
export function createProject(f) {
  const name = clean(f.name, 40); if (!name) fail("Give the project a name.");
  if (loadAll().some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`There's already a project called ${name}.`);
  let id = slug(name) || "project"; while (listIds().includes(id)) id += "-2";
  const folder = expand(String(f.folder || "").trim() || (f.kind === "client" ? "~/Blendd/" + name.replace(/[\\/:*?"<>|]/g, "-") : ""));
  // A new client often has no folder yet: the Desk makes it (Diogo, 2 Nov 2026: "should create!";
  // on a fresh Windows PC the suggested ~/Projects/<name> didn't exist and the Desk refused).
  if (!isAbsolute(folder)) fail("Give the full folder, e.g. ~/Projects/client-name, or use Choose….");
  if (!existsSync(folder)) try { mkdirSync(folder, { recursive: true }); } catch (e) { fail(`The computer didn't let the Desk create ${tilde(folder)} (${e.code || e.message}). Pick another folder with Choose….`); }
  const names = (Array.isArray(f.tracks) ? f.tracks : String(f.tracks || "").split(",")).map((t) => clean(t, 28)).filter(Boolean);
  const tracks = []; for (const n of names.length ? names : ["Main"]) { let tid = slug(n) || "track"; while (tracks.some((t) => t.id === tid)) tid += "-2"; tracks.push({ id: tid, name: n }); }
  const order = Math.max(0, ...loadAll().map((p) => p.order || 0)) + 1;
  const p = { id, name, order, ...(f.kind === "client" ? { kind: "client", shared: true } : {}), color: /^#[0-9a-f]{6}$/i.test(f.color || "") ? f.color : PALETTE[order % PALETTE.length], folder: tilde(folder),
    transcripts: f.kind === "client" ? "shared:meetings/" + id : tilde(join(DESK_HOME, "transcripts", id)), tracks, milestones: [], todos: [], sessions: [], meetings: [], files: [], createdAt: now() };
  ensureChats(p);
  create(p);
  ensureBrief(p);
  return load(id);
}

export function run(op, pid, f = {}) {
  const fn = ops[op]; if (!fn) fail(`Unknown change "${op}".`);
  return fn(pid, f);
}

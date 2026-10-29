// Every change to a project, in one place: the page (through the server) and the `desk` command
// (which sessions run) both come through here, so the rules are the same for both.
import { update, load, loadAll } from "./store.mjs";

// "ongoing": a standing duty that is never finished (e.g. log LQA hours for the monthly report);
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
    if (f.status === "waiting" && !t.waitingOn) t.waitingOn = "Jane";
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

  // ---- tracks ----
  "track.add"(pid, f) {
    return update(pid, (p) => {
      const name = clean(f.name, 28) || "New track";
      let id = slug(name) || "track"; while (p.tracks.some((t) => t.id === id)) id += "-2";
      const t = { id, name }; p.tracks.push(t); return t;
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

  // ---- sessions ----
  "session.add"(pid, f) {
    return update(pid, (p) => {
      if (p.sessions.some((s) => s.id === f.id)) fail("That session is already on the desk.");
      const s = { id: f.id, track: trackOf(p, f.track), name: clean(f.name, 40) || "New session", cwd: f.cwd, createdAt: now(), started: f.started !== false };
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

export function run(op, pid, f = {}) {
  const fn = ops[op]; if (!fn) fail(`Unknown change "${op}".`);
  return fn(pid, f);
}

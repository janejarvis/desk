// Desk — the page. Data comes from the local server (/api/state); changes go back through /api/op,
// and the server pushes "something changed" over /api/events, so sessions' edits show up live.

const I = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  mic: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>',
  clip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3L6.5 11.2a1.2 1.2 0 0 1-1.7-1.7L10 4.3"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
  grid: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6.2 8.2h4M6.2 10.8h4"/></svg>',
};
let ME = "Diogo"; // the one person using the Desk (the server says who, from config.json)
const STATUSES = [["ongoing", "Ongoing"], ["todo", "To do"], ["doing", "Doing"], ["blocked", "Blocked"], ["waiting", "Waiting on"], ["sent", "Sent"], ["done", "Done"]];
const ST_KEYS = STATUSES.map((x) => x[0]);
const EMPTY = { ongoing: "No standing duties.", todo: "Nothing to do.", doing: "Nothing in progress.", blocked: "Nothing blocked.", waiting: "Not waiting on anyone.", sent: "Nothing out for feedback.", done: "Nothing finished recently." };
const ORDER = { waiting: 0, working: 1, idle: 2 };

const $ = (id) => document.getElementById(id);
const FIELD_SIZING = CSS.supports?.("field-sizing", "content");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TODAY = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmt = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T00:00:00" : s); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
const fmtShort = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
// Formatters made once (toLocale…String builds a new one on every call, which added up across long chats).
const F_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }), F_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const clock = (s) => { if (!s) return ""; const d = new Date(s); if (isNaN(d)) return ""; const today = iso(TODAY()) === iso(d); return today ? F_TIME.format(d) : F_DAY.format(d); };
const daysSince = (s) => Math.floor((Date.now() - new Date(s)) / 864e5);
// An ongoing duty is due again one cycle after it was last done.
const CYCLE = { daily: 1, weekly: 7, monthly: 31 };
const ongoingLate = (t) => t.status === "ongoing" && (!t.lastDone || daysSince(t.lastDone) >= (CYCLE[t.every] || 7) + (t.every === "daily" ? 0 : 1));
const dueState = (t) => { if (!t.due || ["done", "sent", "ongoing"].includes(t.status)) return ""; const d = (new Date(t.due + "T00:00:00") - TODAY()) / 864e5; return d < 0 ? "over" : d <= 3 ? "soon" : ""; };
const needsMe = (t) => (t.status === "waiting" && t.waitingOn === ME) || (t.owner === ME && !["done", "sent"].includes(t.status)) || (t.reach && ["todo", "doing", "blocked"].includes(t.status)); // reach: only Diogo's yes starts it
const initials = (n) => n.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "·";

// Claude writes markdown; show it as it reads. Escaped first, so nothing in it becomes HTML.
// Bold, code and links inside a line (also inside a table cell).
const mdInline = (h) => h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/`([^`\n]+)`/g, "<code>$1</code>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
// A markdown table (a | header | line, a |---| line, then rows) drawn as a real table (Diogo, 11 Nov 2026).
const mdRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
function mdTables(h, keep) {
  const L = h.split("\n"), out = [];
  for (let i = 0; i < L.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(L[i]) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1] || "")) {
      const head = mdRow(L[i]), al = mdRow(L[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      const rows = []; let j = i + 2;
      for (; j < L.length && /^\s*\|.*\|\s*$/.test(L[j]); j++) rows.push(mdRow(L[j]));
      const td = (t, c, k) => `<${t}${al[k] ? ` style="text-align:${al[k]}"` : ""}>${mdInline(c || "")}</${t}>`;
      keep.push(`<div class="mdtw"><table class="mdt"><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td("td", r[k], k)).join("")}</tr>`).join("")}</tbody></table></div>`);
      out.push(`\u0001${keep.length - 1}\u0001`); i = j - 1;
    } else out.push(L[i]);
  }
  return out.join("\n");
}
function md(s) {
  const blocks = [], tables = [];
  let h = esc(s).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => { blocks.push(c); return `\u0000${blocks.length - 1}\u0000`; });
  h = mdTables(h, tables);
  h = mdInline(h.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>").replace(/^(\s*)[-*]\s+/gm, "$1• "));
  return h.replace(/\u0001(\d+)\u0001\n?/g, (_, i) => tables[i]).replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[i]}</pre>`);
}

// ---- server ----
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The Desk answered ${r.status}.`);
  return j;
}
const op = (o, project, fields) => api("/api/op", { op: o, project, ...fields }).catch((e) => { toast(e.message, true); throw e; });

let toastT;
// A toast with an Undo button (Today's Done), shown a little longer.
function toastUndo(msg, undo) {
  const t = $("toast"); t.innerHTML = `${esc(msg)} <button class="linkbtn tundo">Undo</button>`; t.className = "toast show";
  t.querySelector(".tundo").onclick = () => { t.className = "toast"; undo(); };
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 6000);
}
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : ""); clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), err ? 5000 : 2200); }

// ---- state ----
let D = { projects: [] };
const S = { fkind: "all", attach: {}, agents: {}, agentsAt: {}, helpersOpen: {}, view: "all", track: "all", tab: "chats", filter: "all", allDone: false, panes: {}, focus: {}, listOpen: false, sheet: false, meet: {}, meetMode: "paste", msForm: null, pendingDel: null, msgs: {}, stream: {}, seen: {}, why: null };
try { const v = JSON.parse(localStorage.getItem("desk-ui") || "null"); if (v) Object.assign(S, { view: v.view || "all", track: v.track || "all", tab: v.tab || "chats", listOpen: !!v.listOpen, panes: v.panes || {} }); } catch {}
const save = () => { try { localStorage.setItem("desk-ui", JSON.stringify({ view: S.view, track: S.track, tab: S.tab, listOpen: S.listOpen, panes: S.panes })); } catch {} };

const P = () => D.projects;
const proj = () => P().find((p) => p.id === S.view);
const scopeP = () => (S.view === "all" || S.view === "today" ? P() : [proj()].filter(Boolean));
const inTrack = (x) => S.view === "all" || S.view === "today" || S.track === "all" || x.track === S.track;
// A whole conversation is shown (it never gets cut), so each reply is turned into HTML once and kept.
const mdDone = new Map();
const mdKept = (t) => { let h = mdDone.get(t); if (h === undefined) { h = md(t); mdDone.set(t, h); } return h; };
const trName = (p, id) => p.tracks.find((t) => t.id === id)?.name || "";
const findS = (id) => { for (const p of P()) { const s = p.sessions.find((x) => x.id === id); if (s) return { p, s }; } return null; };
const allTodos = () => scopeP().flatMap((p) => p.todos.filter(inTrack).map((t) => ({ p, t })));
const allSessions = () => scopeP().flatMap((p) => p.sessions.filter(inTrack).map((s) => ({ p, s })));
const allMeetings = () => scopeP().flatMap((p) => p.meetings.filter(inTrack).map((m) => ({ p, m }))).sort((a, b) => b.m.date.localeCompare(a.m.date));
// The people a project's cards can wait on: only that project's own, so projects never mix.
const people = (p) => [...new Set([ME, ...(p?.todos || []).flatMap((t) => [t.waitingOn, t.sentTo, t.owner])].filter((x) => x && !["Claude", "Managers"].includes(x)))];
// A session counts as working while it replies, or while one of its helpers is still running.
// A chat waiting on Diogo's answer to its question counts as "waiting" (a reply for him), not "working":
// the sidebar shows it like a new reply (10 Nov 2026).
const stateOf = (s) => (s.question?.questions?.length && s.mine !== false) ? "waiting" : (S.stream[s.id]?.active || (s.state === "idle" && (S.agents[s.id] || []).some((a) => a.state === "running")) ? "working" : s.state);

// The page reloads itself when its own files changed (an update), once they've been still for 10 s and you're
// not in the middle of typing; drafts are kept (sessionStorage). 9 Nov 2026: a window ran the old page for days.
let webAt, reloadT = null;
function watchWeb(stamp) {
  if (!stamp) return; if (webAt === undefined) { webAt = stamp; return; }
  if (stamp === webAt) return;
  webAt = stamp; clearTimeout(reloadT);
  reloadT = setTimeout(function go() {
    const a = document.activeElement, typing = a && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName) && (a.value || "").length;
    if (typing || $("askpop") || $("viewer")) { reloadT = setTimeout(go, 5000); return; }
    location.reload();
  }, 10000);
}
async function refresh() {
  try { D = await api("/api/state"); if (D.me) ME = D.me; if ($("ver")) $("ver").textContent = D.version ? "v" + D.version : ""; $("offline")?.remove(); }
  catch { if (!$("offline")) document.body.insertAdjacentHTML("beforeend", '<div class="offline" id="offline">The Desk server isn\'t running. Start it with: desk open</div>'); return; }
  if (!proj() && S.view !== "today") { S.view = P()[0]?.id || "all"; S.track = "all"; }
  if (proj() && S.track !== "all" && !proj().tracks.some((t) => t.id === S.track)) S.track = "all";
  checkNeeds();
  watchWeb(D.web);
  render();
  checkAsks();
}
let refreshT;
const soon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 150); };

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "state") soon();
    else if (ev.type === "leads") { if (proj()?.kind === "sales") loadLeads(); }
    else if (ev.type === "morning") showMorning();
    else if (ev.type === "steer") steerOwner = ev.owner;
    else if (ev.type === "askrun") { if (S.askRun?.id === ev.run.id) { const hidden = !$("askpop"); S.askRun = ev.run; if (!hidden || ev.run.done || ev.run.waiting) askRunPop(); } }
    else if (ev.type === "renamed") {
      for (const k in S.panes) S.panes[k] = S.panes[k].map((id) => (id === ev.from ? ev.to : id));
      for (const k in S.focus) if (S.focus[k] === ev.from) S.focus[k] = ev.to;
      if (S.stream[ev.from]) { S.stream[ev.to] = S.stream[ev.from]; delete S.stream[ev.from]; }
      if (S.msgs[ev.from]) { S.msgs[ev.to] = S.msgs[ev.from]; delete S.msgs[ev.from]; }
      soon();
    } else if (ev.type === "stream") onStream(ev);
  };
  es.onerror = () => { setTimeout(soon, 1500); };
}

function onStream(ev) {
  const st = (S.stream[ev.session] ||= { text: "", tool: "", active: false, queued: 0 });
  // A reply the server picked up again after a restart never sends "start": show it as soon as it
  // produces anything, instead of leaving the pane looking frozen.
  if (!st.active && ["delta", "tool", "message"].includes(ev.kind)) { st.active = true; st.since ||= Date.now(); render(); }
  if (ev.kind === "start") { st.since = Date.now(); st.steps = []; }
  if (ev.kind === "start") { st.active = true; st.text = ""; st.tool = ""; render(); }
  else if (ev.kind === "queued") { st.queued++; }
  else if (ev.kind === "message") { if (st.text && !st.text.endsWith("\n\n")) st.text += "\n\n"; }
  else if (ev.kind === "delta") { st.text += ev.text; st.tool = ""; paintLive(ev.session); }
  else if (ev.kind === "tool") { st.tool = ev.detail || ev.name || st.tool; step(st, ev.detail || ev.name); paintLive(ev.session); }
  else if (ev.kind === "thinking") { step(st, "Thinking…"); paintLive(ev.session); }
  else if (ev.kind === "done") {
    st.active = false; st.queued = Math.max(0, st.queued - 1);
    if (ev.error) toast(ev.error, true);
    else if (ev.wrote === false) toast("The session finished without writing a reply. Ask it what happened.", true);
    { const x = findS(ev.session); if (x) notify(`${x.p.name} · ${x.s.name}`, ev.error ? "Stopped with an error: " + ev.error : (st.text || "").replace(/\s+/g, " ").trim() || "Replied.", ev.session); }
    delete S.msgs[ev.session]; st.text = ""; refresh();
  }
}
// The activity feed: one line per step of the reply, newest last; a repeated "Thinking…" isn't stacked.
function step(st, line) { const s = (st.steps ||= []); if (!line || (line === "Thinking…" && s[s.length - 1] === line)) return; s.push(line); if (s.length > 40) s.splice(0, s.length - 40); }
const feedHTML = (st) => (st.steps || []).slice(-6).map((l, i, a) => `<li class="${i === a.length - 1 ? "now" : ""}">${esc(l)}</li>`).join("");
const workLine = (st) => `${st.tool ? "Working · " + st.tool : "Working"}${st.since ? " · " + dur(new Date(st.since).toISOString()) : ""}`;
// The working line's timer ticks even when nothing new arrives, so a long step never looks frozen.
setInterval(() => { for (const id in S.stream) if (S.stream[id].active) { const w = document.querySelector(`[data-live="${CSS.escape(id)}"] .wk`); if (w) w.textContent = workLine(S.stream[id]); } }, 1000);
/* ---------- Notifications: a reply finished, or something new needs Diogo ---------- */
const canNotify = () => "Notification" in window && Notification.permission === "granted";
const away = () => document.hidden || !document.hasFocus();
function notify(title, body, sid) {
  if (!canNotify() || !away()) return;
  const n = new Notification(title, { body: body.slice(0, 180), tag: sid || title, silent: false });
  n.onclick = () => { window.focus(); const x = sid && findS(sid); if (x) { S.view = x.p.id; S.track = "all"; S.tab = "chats"; openPane(paneKey(), sid); } n.close(); };
}
let knownNeeds = null;
function checkNeeds() { // new cards waiting on Diogo, since the last look
  const now = new Map(P().flatMap((p) => p.todos.filter(needsMe).map((t) => [t.id, [p, t]])));
  if (knownNeeds) for (const [id, [p, t]] of now) if (!knownNeeds.has(id)) notify(`${p.name} · needs you`, t.title);
  knownNeeds = new Set(now.keys());
}
// A reply picked up after a restart replays from its start, so its live text can begin with what is
// already saved above it: show only the part not yet in the conversation.
function unsaid(text, msgs) {
  text = text || ""; const last = [...(msgs || [])].reverse().find((m) => m.who === "claude")?.text || "";
  if (!last) return text;
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  for (const part of last.split(/\n\n+/).map(norm).filter((x) => x.length > 20).reverse()) {
    const i = norm(text).lastIndexOf(part);
    if (i >= 0) { // drop everything up to the end of the already-saved part
      let seen = 0, cut = 0; const target = i + part.length;
      for (; cut < text.length && seen < target; cut++) if (!(/\s/.test(text[cut]) && /\s/.test(text[cut - 1] || " "))) seen++;
      return text.slice(cut).replace(/^\s+/, "");
    }
  }
  return text;
}
// Many small pieces arrive per second while a reply streams; the pane is painted at most once a frame
// (3 Nov 2026: three chats replying at once in UrgentPlumber made the whole Desk lag).
const livePending = new Set();
function paintLive(sid) {
  if (livePending.has(sid)) return;
  livePending.add(sid);
  requestAnimationFrame(() => { livePending.delete(sid); paintLiveNow(sid); });
}
function paintLiveNow(sid) {
  const el = document.querySelector(`[data-live="${CSS.escape(sid)}"]`);
  if (!el) return;
  const st = S.stream[sid];
  el.querySelector(".tx").innerHTML = md(unsaid(st.text, S.msgs[sid]?.list));
  el.querySelector(".wk").textContent = workLine(st);
  const feed = el.querySelector(".feed"); if (feed) feed.innerHTML = feedHTML(st);
  const box = el.closest(".msgs"); if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

// ---- render (keeps focus, drafts and scroll positions across re-renders) ----
function render() {
  const a = document.activeElement, fid = a?.id, sel = fid && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
  const scroll = {};
  // Where each chat is scrolled to, kept as "this message, this far from the top" rather than a pixel
  // count: messages out of view only have an estimated height, so after a redraw the same pixel count
  // is somewhere else (3 Nov 2026: scrolling down kept pulling Diogo back up).
  document.querySelectorAll(".msgs[data-for]").forEach((m) => {
    if (m.scrollHeight - m.scrollTop - m.clientHeight < 40) { scroll[m.dataset.for] = "end"; return; }
    const top = m.getBoundingClientRect().top, kids = m.children;
    let i = 0; while (i < kids.length - 1 && kids[i].getBoundingClientRect().bottom <= top) i++;
    scroll[m.dataset.for] = { i, off: kids[i] ? kids[i].getBoundingClientRect().top - top : 0, px: m.scrollTop };
  });
  const bodyScroll = $("body")?.scrollTop;
  renderRail(); renderMain(); save();
  document.querySelectorAll(".msgs[data-for]").forEach((m) => {
    const v = scroll[m.dataset.for];
    if (v === undefined || v === "end") { m.scrollTop = m.scrollHeight; return; }
    const el = m.children[v.i];
    if (!el) { m.scrollTop = v.px; return; }
    m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - v.off;
  });
  if (bodyScroll && $("body")) $("body").scrollTop = bodyScroll;
  if (fid && $(fid)) { const el = $(fid); el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} }
}

const kindOf = (p) => p.kind || "project";
// The sidebar's order, top to bottom: Projects, then Sales, then Clients. Up/down (keys and STEER) follow it.
const railOrder = () => [{ id: "today", name: "Today" }, ...["project", "sales", "client"].flatMap((k) => P().filter((p) => kindOf(p) === k))];
function railItem(p, unread) {
  const cur = S.view === p.id;
  let h = `<button class="ritem" aria-current="${cur}" data-go="${p.id}" title="${esc(p.name)}"><span class="pavw${unread(p.sessions) ? " ready" : p.sessions.some((s) => stateOf(s) === "working") ? " working" : ""}" title="${p.sessions.some((s) => s.question?.questions?.length) ? "A question is waiting for your answer" : unread(p.sessions) ? "A reply is waiting for you" : p.sessions.some((s) => stateOf(s) === "working") ? "Working…" : ""}"><span class="pav${p.logo ? " logo" : ""}" style="background:${p.color}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : esc(p.kind === "sales" ? "€" : p.name[0])}</span></span><span class="nm">${esc(p.name)}</span><span class="live">${p.kind === "sales" ? "" : p.sessions.map((s) => `<span class="dot ${stateOf(s)}"></span>`).join("")}</span></button>`;
  // No track list under the project here: just projects (Diogo, 3 Nov 2026). Tracks are the chips at the top.
  return h;
}
// Three separate areas (Diogo, 2 Nov 2026): this person's own Projects, then Sales and the Blendd
// Clients, which are shared with the partner. Each list ends with its own "New" button.
function renderRail() {
  const r = $("rail");
  const unread = (ss) => ss.some((s) => stateOf(s) === "waiting");
  const newBtn = (kind, label) => `<button class="ritem newproj" data-new="${kind}" title="${label}"><span class="pav plus">+</span><span class="nm">${label}</span></button>`;
  const shared = D.sync?.shared || P().some((p) => p.shared) || D.sync?.ok === false;
  let h = `<button class="ritem todayitem" aria-current="${S.view === "today"}" data-go="today" title="Today: what waits on you"><span class="pav sun">☀</span><span class="nm">Today</span></button><div class="rsep"></div>`;
  h += `<div class="rail-label">Projects</div>` + P().filter((p) => kindOf(p) === "project").map((p) => railItem(p, unread)).join("") + newBtn("project", "New project");
  if (shared) {
    const sales = P().filter((p) => kindOf(p) === "sales");
    if (sales.length) h += `<div class="rsep"></div><div class="rail-label">Sales<span class="rshared">shared</span></div>` + sales.map((p) => railItem(p, unread)).join("");
    h += `<div class="rsep"></div><div class="rail-label">Clients<span class="rshared">shared</span></div>` + P().filter((p) => kindOf(p) === "client").map((p) => railItem(p, unread)).join("") + newBtn("client", "New client");
  }
  r.innerHTML = h;
  const all = P().flatMap((p) => p.sessions);
  const nbtn = "Notification" in window && Notification.permission === "default" ? `<button class="linkbtn" id="notifyon">Turn on notifications</button><br>` : "";
  const sy = D.sync || {}, other = ME === "Diogo" ? "João" : "Diogo";
  // Until the first sync works, the username box and Connect are always there (2 Nov 2026: João only saw "Syncing…").
  const connect = `<br><input class="ghuser" id="ghuser" placeholder="Your GitHub username" value="${esc(S.ghDraft ?? sy.github ?? "")}"><button class="linkbtn" id="syncnow">Connect</button>`;
  const syncLine = !shared ? "" : sy.ok === true ? `<br>Sales and Clients synced with ${other} · ${esc(clock(sy.at))}` : sy.ok === false ? `<br><span class="syncerr">${esc(sy.error || "Sales and Clients aren't syncing.")}</span>` + connect : `<br>${sy.busy ? "Syncing Sales and Clients…" : "Sales and Clients aren't connected yet."}` + connect;
  $("railfoot").innerHTML = nbtn + `<button class="linkbtn morningbtn" id="morningbtn" title="Today: what waits on you"><b>${fmt(new Date().toISOString())}</b></button><br>${all.filter((s) => stateOf(s) === "working").length} working · ${all.filter((s) => stateOf(s) === "waiting").length} new replies` + syncLine;
  $("notifyon")?.addEventListener("click", () => Notification.requestPermission().then(() => render()));
  $("ghuser")?.addEventListener("input", (e) => { S.ghDraft = e.target.value; });   // what's typed survives the sidebar redrawing
  $("morningbtn").onclick = () => { S.view = "today"; render(); };
  $("syncnow")?.addEventListener("click", async (e) => { const github = $("ghuser")?.value.trim(); if (!github) return toast("Type your GitHub username first (the account that accepted the invite).", true); e.target.textContent = "Connecting… (a GitHub sign-in window may open)"; e.target.disabled = true; try { await api("/api/sync", { github }); } catch {} refresh(); });
  r.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { if (S.view !== b.dataset.go) { S.view = b.dataset.go; S.track = "all"; S.sheet = false; S.filter = "all"; S.msForm = null; S.lead = null; if (proj()?.kind === "sales") S.tab = "leads"; else if (["leads", "outreach"].includes(S.tab)) S.tab = "chats"; } render(); }));
  r.querySelectorAll("[data-track]").forEach((b) => (b.onclick = () => { S.track = S.track === b.dataset.track ? "all" : b.dataset.track; S.msForm = null; render(); }));
  r.querySelectorAll("[data-new]").forEach((b) => (b.onclick = () => newProject(b.dataset.new)));
}

// Sales has its own tabs; every project and client gets a Numbers tab (Diogo, 2 Nov 2026).
const PTABS = [["chats", "Chats"], ["roadmap", "Roadmap"], ["board", "Board"], ["numbers", "Numbers"], ["meetings", "Meetings"], ["files", "Files"]];
const SALES_TABS = [["leads", "Leads"], ["outreach", "Outreach"], ["numbers", "Numbers"], ["files", "Files"]]; // no Chats (Diogo, 2 Nov 2026)
function renderMain() {
  if (S.view === "today") return renderToday();
  const p = proj();
  const tabs = p?.kind === "sales" ? SALES_TABS : p ? PTABS : PTABS.filter(([k]) => k !== "numbers");
  if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
  const unread = allSessions().some((x) => stateOf(x.s) === "waiting");
  let h = `<div class="top"><h1 title="${p ? esc(p.folder) : ""}">${p ? esc(p.name) : "All projects"}</h1>
    <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${k === "chats" && unread ? '<span class="udot" title="New replies"></span>' : ""}</button>`).join("")}</div>`;
  if (p) h += `<button class="chip brief" id="briefbtn" title="What every session reads first about ${esc(p.name)}">Brief</button>`;
  if (p && p.kind !== "sales") h += `<div class="tracks">${p.tracks.length > 1 ? `<button class="chip" data-tr="all" aria-pressed="${S.track === "all"}">All tracks</button>` : ""}${p.tracks.map((t) => trackChip(p, t)).join("")}<button class="chip add" id="addtrack">${I.plus}Track</button></div>`;
  h += `</div><div class="body${S.tab === "chats" ? " chat-body" : ""}" id="body"></div>`;
  // On Chats, a redraw that changes nothing up top keeps the page as it is and only updates the chats
  // that changed (3 Nov 2026: rebuilding every long chat on each redraw lagged and lost the scroll place).
  if (S.tab === "chats" && $("main")._top === h + (p?.id || "") && $("body")?.classList.contains("chat-body")) { renderChats(); return; }
  $("main").innerHTML = h; $("main")._top = h + (p?.id || "");
  $("main").querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); }));
  if (p) $("briefbtn").onclick = () => openBrief(p);
  if (p && p.kind !== "sales") wireTracks(p); else if (p) { $("briefbtn").onclick = () => openBrief(p); }
  ({ chats: renderChats, roadmap: renderRoadmap, board: renderBoard, meetings: renderMeetings, files: renderFiles, leads: renderLeads, outreach: renderOutreach, numbers: p?.kind === "sales" ? renderSalesNumbers : renderNumbers }[S.tab] || renderChats)();
}

function trackChip(p, t) {
  const on = p.tracks.length === 1 || S.track === t.id;
  return `<button class="chip" data-tr="${t.id}" aria-pressed="${on && p.tracks.length > 1}"><span>${esc(t.name)}</span>${on ? `<span class="edit" role="button" tabindex="0" aria-label="Rename track ${esc(t.name)}" data-rename="${t.id}">${I.pen}</span>${p.tracks.length > 1 ? `<span class="edit del" role="button" tabindex="0" aria-label="Delete track ${esc(t.name)}" title="Delete this track" data-deltrack="${t.id}">×</span>` : ""}` : ""}</button>`;
}
function wireTracks(p) {
  const m = $("main");
  m.querySelectorAll("[data-tr]").forEach((b) => (b.onclick = (e) => { if (e.target.closest("[data-rename]") || e.target.tagName === "INPUT") return; S.track = b.dataset.tr; S.msForm = null; render(); }));
  m.querySelectorAll("[data-rename]").forEach((el) => { const go = (e) => { e.stopPropagation(); startRename(p, el.dataset.rename, el.closest(".chip")); }; el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } }; });
  m.querySelectorAll("[data-deltrack]").forEach((el) => { const go = (e) => { e.stopPropagation(); deleteTrack(p, el.dataset.deltrack); }; el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } }; });
  $("addtrack").onclick = async () => { const t = (await op("track.add", p.id, { name: "New track" })).result; await refresh(); S.track = t.id; render(); const c = document.querySelector(`.chip[data-tr="${t.id}"]`); if (c) startRename(proj(), t.id, c); };
}
// Delete a track (Diogo, 9 Nov 2026): its cards, milestones, meetings and files go to the track picked here;
// its chats leave the Desk, their conversations staying on this computer (lib/ops.mjs track.remove).
function deleteTrack(p, id) {
  const t = p.tracks.find((x) => x.id === id); if (!t) return;
  const others = p.tracks.filter((x) => x.id !== id), n = (k) => (p[k] || []).filter((x) => x.track === id).length;
  const chats = p.sessions.filter((s) => s.track === id);
  if (chats.some((s) => stateOf(s) === "working")) return toast(`${t.name}'s chat is replying: wait until it's done, then delete the track.`, true);
  const what = [[n("todos"), "card"], [n("milestones"), "milestone"], [n("meetings"), "meeting"], [n("files"), "file"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(", ");
  const pop = askPop(`<div class="vhead"><div class="vt"><b>Delete the ${esc(t.name)} track?</b><span>${esc(p.name)}</span></div><button class="x" data-close-pop aria-label="Close">×</button></div><div class="askbody">
    <p>${what ? `Its ${esc(what)} move to:` : "Nothing is on it but its chat."}</p>${what ? `<select class="lsel" id="trto">${others.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select>` : ""}
    ${chats.length ? `<p class="mfoot">Its chat${chats.length === 1 ? "" : "s"} (${esc(chats.map((s) => s.name).join(", "))}) leave${chats.length === 1 ? "s" : ""} the Desk; the conversation stays on this computer.</p>` : ""}
    <div class="db"><button type="button" class="btn primary" id="trdel">Delete track</button><button type="button" class="linkbtn" data-close-pop>Cancel</button></div></div>`, "Delete track");
  $("trdel").onclick = async () => {
    try { const r = (await op("track.remove", p.id, { id, to: $("trto")?.value || others[0].id })).result; pop.remove(); if (S.track === id) S.track = "all"; await refresh(); toast(`Deleted ${r.removed}${what ? ` · moved to ${r.to}` : ""}.`); } catch {}
  };
}
function startRename(p, id, chip) {
  const t = p.tracks.find((x) => x.id === id); if (!t || !chip) return;
  chip.innerHTML = `<input id="rename-${id}" value="${esc(t.name)}" maxlength="28" aria-label="Track name">`;
  const inp = chip.querySelector("input"); inp.focus(); inp.select();
  let done = false;
  const fin = async (ok) => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== t.name) { await op("track.rename", p.id, { id, name: v }).catch(() => {}); refresh(); } else render(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); fin(true); } if (e.key === "Escape") fin(false); };
  inp.onblur = () => fin(true); inp.onclick = (e) => e.stopPropagation();
}

// "Ask the session to set this up" — for an empty roadmap or board.
function fillBox(p, what, only) {
  const trs = only ? [only] : S.track === "all" ? p.tracks : p.tracks.filter((t) => t.id === S.track);
  const t = trs.find((x) => p.sessions.some((s) => s.track === x.id)) || trs[0];
  const s = t && p.sessions.find((x) => x.track === t.id);
  const name = p.tracks.length > 1 ? `${esc(p.name)} · ${esc(t?.name)}` : esc(p.name);
  return `<div class="fill"><p>${what} for ${name} is empty.</p>${s ? `<p class="hint">The session “${esc(s.name)}” knows this work. It can set up the milestones and to-dos from what it already knows.</p><button class="btn primary" data-fill="${t.id}">Ask “${esc(s.name)}” to set it up</button>` : `<p class="hint">Start a session on this track first, in Chats.</p>`}</div>`;
}
function wireFill(p) {
  $("body").querySelectorAll("[data-fill]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const r = await api("/api/fill", { project: p.id, track: b.dataset.fill }); toast("Asked. Watch it fill in, or follow along in Chats."); openPane(paneKey(), r.session); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

/* ---------- Board ---------- */
function renderBoard() {
  const b = $("body"), p = proj();
  let h = `<div class="tools"><div class="filters">${[["all", "Everything"], ["me", "Waiting on " + ME], ["over", "Overdue"]].map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`).join("")}</div>
    <label class="toggle"><input type="checkbox" id="alldone"${S.allDone ? " checked" : ""}> Show all done (default: last 7 days)</label></div>`;
  h += `<form class="addform" id="addform"><input type="text" id="a-title" placeholder="Add a to-do…" maxlength="200" autocomplete="off">
    <select id="a-where" aria-label="Project and track">${scopeP().flatMap((pp) => pp.tracks.map((t) => `<option value="${pp.id}|${t.id}"${p && S.track === t.id ? " selected" : ""}>${esc(p ? t.name : pp.name + " · " + t.name)}</option>`)).join("")}</select>
    <select id="a-kind" aria-label="Kind"><option value="">One-off</option><option value="daily">Ongoing · every day</option><option value="weekly">Ongoing · every week</option><option value="monthly">Ongoing · every month</option></select>
    <select id="a-prio" aria-label="Priority"><option value="1">P1</option><option value="2" selected>P2</option><option value="3">P3</option></select>
    <select id="a-wait" aria-label="Who"></select>
    <input type="date" id="a-due" aria-label="Due date"><button class="btn primary" id="a-btn" disabled>Add</button></form><div id="lanes"></div>`;
  b.innerHTML = h;
  const filt = (t) => (S.filter === "me" ? needsMe(t) : S.filter === "over" ? dueState(t) === "over" || ongoingLate(t) : true);
  const lanes = $("lanes");
  if (p && !p.todos.some(inTrack) && S.filter === "all") lanes.innerHTML = fillBox(p, "The board");
  else if (S.filter !== "all") {
    let g = `<div class="needgrid">`, any = false;
    for (const pp of scopeP()) {
      const its = pp.todos.filter((t) => inTrack(t) && filt(t)).sort(sortFn); if (!its.length) continue; any = true;
      g += `<section class="projblock"><div class="phead"><span class="sw" style="background:${pp.color}"></span><b>${esc(pp.name)}</b></div><div class="drop">${its.map((t) => card(pp, t)).join("")}</div></section>`;
    }
    lanes.innerHTML = any ? g + "</div>" : `<div class="empty">${S.filter === "me" ? "Nothing is waiting on you." : "Nothing is overdue."}</div>`;
  } else if (!p) {
    let g = `<div class="hscroll"><div class="swim"><div class="cols six lanehead">${STATUSES.map(([st, l]) => `<div class="col ${st}"><h3>${l}</h3></div>`).join("")}</div>`;
    for (const pp of P()) g += `<section class="projblock"><div class="phead"><span class="sw" style="background:${pp.color}"></span><b>${esc(pp.name)}</b></div><div class="cols six">${cols(pp, pp.todos, false)}</div></section>`;
    lanes.innerHTML = g + `</div></div>`;
  } else lanes.innerHTML = `<div class="hscroll"><div class="cols six">${cols(p, p.todos.filter(inTrack), true)}</div></div>`;
  b.querySelectorAll("[data-f]").forEach((x) => (x.onclick = () => { S.filter = x.dataset.f; render(); }));
  $("alldone").onchange = (e) => { S.allDone = e.target.checked; render(); };
  const fillWho = () => { const pp = P().find((x) => x.id === $("a-where").value.split("|")[0]); $("a-wait").innerHTML = `<option value="">Claude does it</option>${people(pp).map((n) => `<option value="${esc(n)}">Waiting on ${esc(n)}</option>`).join("")}`; };
  fillWho(); $("a-where").onchange = fillWho;
  $("a-title").oninput = (e) => { $("a-btn").disabled = !e.target.value.trim(); };
  $("addform").onsubmit = async (e) => {
    e.preventDefault(); const v = $("a-title").value.trim(); if (!v) return;
    const [pid, track] = $("a-where").value.split("|"); const w = $("a-wait").value;
    const every = $("a-kind").value;
    await op("todo.add", pid, every ? { title: v, track, status: "ongoing", every, owner: w || "Claude" } : { title: v, track, priority: +$("a-prio").value, due: $("a-due").value || "", waitingOn: w, owner: w ? "" : "Claude" }).catch(() => {});
    $("a-title").value = ""; $("a-due").value = ""; await refresh(); $("a-title")?.focus();
  };
  wireFill(p);
  wireCards();
}
const sortFn = (a, b) => (a.priority - b.priority) || ((a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : 0);
const recentDone = (t) => S.allDone || daysSince(t.doneAt || t.updatedAt) <= 7;
function cols(p, items, head) {
  return STATUSES.map(([st, lab]) => {
    let its = items.filter((t) => t.status === st), hidden = 0;
    if (st === "done") { const n = its.length; its = its.filter(recentDone).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || "")); hidden = n - its.length; } else its.sort(sortFn);
    return `<div class="col ${st}">${head ? `<h3>${lab}${hidden ? `<span class="n">+${hidden} older</span>` : ""}</h3>` : ""}<div class="drop" data-st="${st}" data-p="${p.id}">${its.length ? its.map((t) => card(p, t)).join("") : `<div class="empty">${EMPTY[st]}</div>`}</div></div>`;
  }).join("");
}
function card(p, t) {
  const ds = dueState(t), ms = p.milestones.find((m) => m.id === t.milestone);
  let meta = t.status === "ongoing" ? "" : `<span class="pill${t.priority === 1 ? " p1" : ""}">P${t.priority || 2}</span>`;
  if (t.status === "ongoing") meta += `<span class="pill ${ongoingLate(t) ? "over" : "ok"}">↻ ${{ daily: "Every day", weekly: "Every week", monthly: "Every month" }[t.every] || "Every week"}</span><span>${t.lastDone ? "Last done " + fmt(t.lastDone) : "Not done yet"}</span>`;
  if (t.due) meta += `<span class="pill ${ds}">${ds === "over" ? "Overdue · " : "Due "}${fmt(t.due)}</span>`;
  if (t.status === "doing") { const n = daysSince(t.updatedAt); if (n >= 3) meta += `<span class="pill stale">No update ${n}d</span>`; }
  if (t.status === "done" && t.doneAt) meta += `<span class="pill ok">Done ${fmt(t.doneAt)}</span>`;
  if (t.status === "blocked" && t.why) meta += `<span class="pill blk">Blocked · ${esc(t.why)}</span>`;
  if (t.status === "waiting") meta += `<select class="waitsel" data-wait="${t.id}" data-p="${p.id}" aria-label="Waiting on">${people(p).map((n) => `<option${n === (t.waitingOn || ME) ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
  if (t.status === "sent") meta += `<span class="pill sentp">Sent${t.sentTo ? " to " + esc(t.sentTo) : ""}${t.sentAt ? " · " + fmt(t.sentAt) : ""}</span>`;
  const area = [(S.view === "all" || p.tracks.length > 1) && S.track === "all" ? (S.view === "all" ? p.name + " · " : "") + trName(p, t.track) : "", ms ? ms.title : ""].filter(Boolean).join(" · ");
  if (area) meta += `<span>${esc(area)}</span>`;
  if (t.owner && t.owner !== "Claude") meta += `<span>· ${esc(t.owner)}</span>`;
  const why = t.status === "blocked" && !t.why ? `<input class="whyin" id="why-${t.id}" data-why="${t.id}" data-p="${p.id}" placeholder="Why is it blocked?" maxlength="200">` : "";
  return `<div class="card" draggable="true" tabindex="0" data-id="${t.id}" data-p="${p.id}"><div class="tt" data-title="${t.id}" title="Double-click to edit">${esc(t.title)}</div><div class="meta">${meta}</div>${why}${t.note ? `<details class="note"><summary>Note</summary><div>${md(t.note)}</div></details>` : ""}<div class="cardfoot">${t.status === "ongoing" ? `<button class="btn tick" data-tick="${t.id}" data-p="${p.id}">${I.check}Did it</button>` : "<span></span>"}<button class="linkbtn${S.pendingDel === t.id ? " danger" : ""}" data-del="${t.id}" data-p="${p.id}">${S.pendingDel === t.id ? "Confirm remove" : "Remove"}</button></div></div>`;
}
function wireCards() {
  const b = $("body"); let drag = null;
  const tOf = (pid, id) => P().find((p) => p.id === pid)?.todos.find((t) => t.id === id);
  b.querySelectorAll("[data-del]").forEach((x) => (x.onclick = async (e) => {
    e.stopPropagation(); const id = x.dataset.del;
    if (S.pendingDel === id) { S.pendingDel = null; await op("todo.remove", x.dataset.p, { id }).catch(() => {}); refresh(); }
    else { S.pendingDel = id; render(); setTimeout(() => { if (S.pendingDel === id) { S.pendingDel = null; render(); } }, 4000); }
  }));
  b.querySelectorAll("[data-tick]").forEach((x) => { x.onmousedown = (e) => e.stopPropagation(); x.onclick = async () => { x.disabled = true; await op("todo.tick", x.dataset.p, { id: x.dataset.tick }).catch(() => {}); toast("Noted: done today."); refresh(); }; });
  b.querySelectorAll("[data-wait]").forEach((x) => { x.onmousedown = (e) => e.stopPropagation(); x.onchange = async () => { await op("todo.set", x.dataset.p, { id: x.dataset.wait, waitingOn: x.value }).catch(() => {}); refresh(); }; });
  b.querySelectorAll("[data-why]").forEach((x) => { x.onmousedown = (e) => e.stopPropagation(); x.onkeydown = async (e) => { if (e.key === "Enter" && x.value.trim()) { await op("todo.set", x.dataset.p, { id: x.dataset.why, why: x.value.trim() }).catch(() => {}); refresh(); } }; x.onblur = async () => { if (x.value.trim()) { await op("todo.set", x.dataset.p, { id: x.dataset.why, why: x.value.trim() }).catch(() => {}); refresh(); } }; });
  b.querySelectorAll("[data-title]").forEach((x) => (x.ondblclick = () => {
    const card = x.closest(".card"); card.draggable = false; x.contentEditable = "true"; x.focus();
    const r = document.createRange(); r.selectNodeContents(x); getSelection().removeAllRanges(); getSelection().addRange(r);
    const fin = async (ok) => { x.contentEditable = "false"; card.draggable = true; const v = x.textContent.trim(); if (ok && v) { await op("todo.set", card.dataset.p, { id: card.dataset.id, title: v }).catch(() => {}); } refresh(); };
    x.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); x.onblur = null; fin(true); } if (e.key === "Escape") { x.onblur = null; fin(false); } };
    x.onblur = () => fin(true);
  }));
  b.querySelectorAll(".card").forEach((el) => {
    el.ondragstart = (e) => { if (e.target.closest?.("details,button,select,input,.tick") || el.querySelector('[contenteditable="true"]')) { e.preventDefault(); return; } drag = el; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", el.dataset.id); } catch {} };
    el.ondragend = () => el.classList.remove("dragging");
    el.onkeydown = async (e) => {
      if (e.target !== el || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = tOf(el.dataset.p, el.dataset.id); const i = ST_KEYS.indexOf(t.status) + (e.key === "ArrowRight" ? 1 : -1); if (i < 0 || i >= ST_KEYS.length) return;
      e.preventDefault(); await move(el.dataset.p, t, ST_KEYS[i]); document.querySelector(`.card[data-id="${t.id}"]`)?.focus();
    };
  });
  b.querySelectorAll(".drop[data-st]").forEach((z) => {
    z.ondragover = (e) => { if (!drag || drag.dataset.p !== z.dataset.p) return; e.preventDefault(); z.classList.add("over"); };
    z.ondragleave = () => z.classList.remove("over");
    z.ondrop = async (e) => { e.preventDefault(); z.classList.remove("over"); if (!drag || drag.dataset.p !== z.dataset.p) return; const t = tOf(drag.dataset.p, drag.dataset.id); drag = null; if (t) await move(z.dataset.p, t, z.dataset.st); };
  });
}
async function move(pid, t, st) {
  if (t.status === st) return;
  t.status = st; render(); // show it straight away; the server's copy follows
  await op("todo.set", pid, { id: t.id, status: st }).catch(() => {});
  await refresh();
  if (st === "blocked") $("why-" + t.id)?.focus();
}

/* ---------- Roadmap ---------- */
function progress(p, m) { const ts = p.todos.filter((t) => t.milestone === m.id); return [ts.filter((t) => t.status === "done").length, ts.length]; }
const RANK = { ongoing: 6, blocked: 0, doing: 1, waiting: 2, todo: 3, sent: 4, done: 5 };
function renderRoadmap() {
  const b = $("body"), p = proj();
  if (!p) {
    let h = `<div class="overview">`;
    for (const pp of P()) {
      h += `<section class="ovp"><div class="phead" style="border:0;padding:0"><span class="sw" style="background:${pp.color}"></span><b>${esc(pp.name)}</b><button class="linkbtn" data-openp="${pp.id}" style="margin-left:auto">Open roadmap</button></div>`;
      for (const t of pp.tracks) {
        const ms = pp.milestones.filter((m) => m.track === t.id);
        h += `<div class="ovtr"><span>${esc(t.name)}</span><div class="mini">${ms.length ? ms.map((m, i) => `${i ? '<span class="arr">→</span>' : ""}<span class="mm ${m.status}">${m.status === "done" ? "✓ " : ""}${esc(m.title)}${m.due ? " · " + fmtShort(m.due) : ""}</span>`).join("") : '<span class="hint">No milestones yet</span>'}</div></div>`;
      }
      h += `</section>`;
    }
    b.innerHTML = h + `</div>`;
    b.querySelectorAll("[data-openp]").forEach((x) => (x.onclick = () => { S.view = x.dataset.openp; S.track = "all"; render(); }));
    return;
  }
  const shown = S.track === "all" ? p.tracks : p.tracks.filter((t) => t.id === S.track);
  let h = "";
  for (const t of shown) {
    const ms = p.milestones.filter((m) => m.track === t.id), now = ms.find((m) => m.status === "now");
    h += `<section class="rtrack"><div class="rhead"><b>${esc(t.name)}</b>${now ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent)">Now: ${esc(now.title)}</span>` : ""}</div>${ms.length || S.msForm === "new:" + t.id ? "" : fillBox(p, "The roadmap", t)}<div class="line">`;
    for (const m of ms) {
      if (S.msForm === m.id) { h += `<div class="msc ${m.status}"><span class="rl"></span><span class="node">${m.status === "done" ? I.check : ""}</span>${msForm(p, t.id, m)}</div>`; continue; }
      const [d, n] = progress(p, m); const ts = p.todos.filter((x) => x.milestone === m.id && x.status !== "ongoing").sort((a, c) => RANK[a.status] - RANK[c.status] || a.priority - c.priority);
      h += `<div class="msc ${m.status}"><span class="rl"></span><span class="node">${m.status === "done" ? I.check : ""}</span><div class="mbox"><div class="md"><span>${m.status === "done" ? "Done" : m.status === "now" ? "Now" : "Next"}</span><span>${m.due ? (m.status === "done" ? "" : "Due ") + fmtShort(m.due) : ""}</span></div><div class="mt" data-editms="${m.id}" title="Click to edit">${esc(m.title)}</div>${n ? `<div class="bar" title="${d} of ${n} done"><i style="width:${Math.round((d / n) * 100)}%"></i></div>` : ""}
        <ul class="mlist">${ts.length ? ts.map((x) => `<li class="${x.status}"><span class="s"></span><span>${esc(x.title)}${x.status === "waiting" ? ` <span class="wt">· waiting on ${esc(x.waitingOn)}</span>` : x.status === "blocked" ? ' <span class="bl">· blocked</span>' : x.status === "sent" ? ` <span class="sn">· sent${x.sentTo ? " to " + esc(x.sentTo) : ""}</span>` : ""}</span></li>`).join("") : '<li style="color:var(--ink-3)">No to-dos yet</li>'}</ul></div></div>`;
    }
    h += S.msForm === "new:" + t.id ? `<div class="msc next" style="margin-top:34px">${msForm(p, t.id, null)}</div>` : `<button class="addms" data-addms="${t.id}">${I.plus} Milestone</button>`;
    h += `</div></section>`;
  }
  b.innerHTML = h;
  b.querySelectorAll("[data-addms]").forEach((x) => (x.onclick = () => { S.msForm = "new:" + x.dataset.addms; render(); $("ms-title")?.focus(); }));
  b.querySelectorAll("[data-editms]").forEach((x) => (x.onclick = () => { S.msForm = x.dataset.editms; render(); $("ms-title")?.focus(); }));
  const f = $("msform");
  if (f) {
    $("ms-cancel").onclick = () => { S.msForm = null; render(); };
    const rm = $("ms-remove"); if (rm) rm.onclick = async () => { if (rm.dataset.sure) { await op("milestone.remove", p.id, { id: S.msForm }).catch(() => {}); S.msForm = null; refresh(); } else { rm.dataset.sure = "1"; rm.textContent = "Confirm remove"; rm.classList.add("danger"); } };
    f.onsubmit = async (e) => {
      e.preventDefault(); const title = $("ms-title").value.trim(); if (!title) return;
      const fields = { title, due: $("ms-due").value || "", status: $("ms-status").value };
      if (S.msForm.startsWith("new:")) await op("milestone.add", p.id, { ...fields, track: S.msForm.slice(4) }).catch(() => {});
      else await op("milestone.set", p.id, { ...fields, id: S.msForm }).catch(() => {});
      S.msForm = null; refresh();
    };
  }
  wireFill(p);
}
function msForm(p, track, m) {
  return `<form class="msform" id="msform"><input id="ms-title" value="${esc(m?.title || "")}" placeholder="Milestone" maxlength="120" aria-label="Milestone title">
    <div class="r"><select id="ms-status" aria-label="Status">${[["next", "Next"], ["now", "Now"], ["done", "Done"]].map(([k, l]) => `<option value="${k}"${(m?.status || "next") === k ? " selected" : ""}>${l}</option>`).join("")}</select><input type="date" id="ms-due" value="${esc(m?.due || "")}" aria-label="Due date"></div>
    <div class="r"><button class="btn primary">${m ? "Save" : "Add"}</button><button type="button" class="btn" id="ms-cancel">Cancel</button>${m ? '<button type="button" class="linkbtn" id="ms-remove" style="margin-left:auto">Remove</button>' : ""}</div></form>`;
}

/* ---------- Meetings ---------- */
const transcripts = {};
function renderMeetings() {
  const b = $("body"), p = proj(), list = allMeetings(), key = paneKey();
  let cur = list.find((x) => x.m.id === S.meet[key]) || list[0]; if (cur) S.meet[key] = cur.m.id;
  const dest = scopeP().flatMap((pp) => pp.tracks.map((t) => `<option value="${pp.id}|${t.id}"${p && S.track === t.id ? " selected" : ""}>${esc(p ? t.name : pp.name + " · " + t.name)}</option>`)).join("");
  const where = p ? esc(p.transcripts) : "each project's transcripts folder";
  let h = `<div class="seg mmode" role="tablist" aria-label="Add a transcript"><button role="tab" data-mm="paste" aria-selected="${S.meetMode === "paste"}">Paste text</button><button role="tab" data-mm="file" aria-selected="${S.meetMode === "file"}">Upload file</button></div>`;
  if (S.meetMode === "paste") h += `<form class="pastebox" id="pasteform"><div class="r"><input type="text" id="pt-title" placeholder="Meeting name, e.g. Weekly with João" maxlength="80" autocomplete="off"><input type="date" id="pt-date" value="${iso(new Date())}" aria-label="Meeting date"><select id="mt-where" aria-label="Project and track">${dest}</select></div>
    <textarea id="pt-text" placeholder="Paste the transcript here…" aria-label="Transcript"></textarea>
    <div class="r"><span class="hint">Saved to ${where} as date_name, then a session on that track reads it right away.</span><button class="btn primary" id="pt-send" disabled>${I.send}Send</button></div></form>`;
  else h += `<label class="upload" id="drop" for="mt-file"><span class="ic">${I.doc}</span><span class="tx"><b>Drop a meeting transcript here</b><span>.txt, .md, .vtt, .srt or .docx · saved to ${where}, then read by a session</span></span>
    <select id="mt-where" aria-label="Project and track">${dest}</select><span class="btn primary">Choose file</span><input type="file" id="mt-file" accept=".txt,.md,.vtt,.srt,.docx"></label>`;
  if (!list.length) { b.innerHTML = h + `<div class="empty">No meetings yet. Paste a transcript above and a session reads it: it writes a short summary and puts every action on the board.</div>`; wireMeetings(p, null); return; }
  h += `<div class="meetwrap"><div class="mtlist">`;
  let lastP = null;
  for (const { p: pp, m } of p ? list : [...list].sort((a, c) => P().indexOf(a.p) - P().indexOf(c.p) || c.m.date.localeCompare(a.m.date))) {
    if (!p && lastP !== pp) { h += `<div class="grp">${esc(pp.name)}</div>`; lastP = pp; }
    const added = m.actions.filter((a) => a.added).length;
    h += `<button class="mrow" data-m="${m.id}" aria-current="${cur.m.id === m.id}"><span class="nm"><span>${esc(m.title)}</span><span class="tm">${fmtShort(m.date)}</span></span><span class="sub">${m.status === "new" ? '<span class="pill wait">Not read yet</span>' : m.status === "reading" ? '<span class="pill" style="background:var(--accent-soft);color:var(--accent)">Being read</span>' : `<span class="pill ok">Read</span>${m.actions.length ? `<span>${added} of ${m.actions.length} on the board</span>` : ""}`}${pp.tracks.length > 1 ? `<span>· ${esc(trName(pp, m.track))}</span>` : ""}</span></button>`;
  }
  const { p: mp, m } = cur;
  h += `</div><div class="reader"><div class="rh"><div><h3>${esc(m.title)}</h3><div class="file">${esc(mp.transcripts)}/${esc(m.file)}</div></div><div class="meta"><span class="pill">${fmt(m.date)}</span><span class="pill">${esc(mp.name)} · ${esc(trName(mp, m.track))}</span></div></div>`;
  if (m.status === "read") {
    h += `<div class="box"><h2>Summary</h2><p>${md(m.summary || "")}</p></div>`;
    if (m.actions.length) h += `<div class="box"><h2>Actions, on the board</h2><ul class="acts">${m.actions.map((a) => `<li><span>${esc(a.title)}</span></li>`).join("")}</ul></div>`;
  } else if (m.status === "reading") {
    const by = mp.sessions.find((s) => s.id === m.readBy);
    h += `<div class="box"><h2>Being read</h2><p>${by ? `“${esc(by.name)}” is reading it.` : "A session is reading it."} The summary appears here and every action goes straight on the board.</p><div class="reading"><button class="btn" id="mt-reread">Read it again</button></div></div>`;
  } else {
    h += `<div class="box"><h2>Not read yet</h2><p>Pick a session to read it. It writes a short summary and puts every action on the board.</p>
      <div class="reading"><select id="mt-by" aria-label="Session">${mp.sessions.map((s) => `<option value="${s.id}"${s.track === m.track ? " selected" : ""}>${esc(s.name)}</option>`).join("")}<option value="new">A new session</option></select><button class="btn primary" id="mt-read">Read it</button></div></div>`;
  }
  h += `<div class="box" style="gap:8px"><h2>Transcript</h2><pre class="transcript" id="mt-text">${esc(transcripts[m.id] ?? "Loading…")}</pre></div></div></div>`;
  b.innerHTML = h; wireMeetings(p, cur);
  if (transcripts[m.id] === undefined) api(`/api/transcript?project=${mp.id}&id=${m.id}`).then((r) => { transcripts[m.id] = r.text; const el = $("mt-text"); if (el) el.textContent = r.text; }).catch(() => {});
}
function wireMeetings(p, cur) {
  const b = $("body"), key = paneKey();
  b.querySelectorAll("[data-mm]").forEach((x) => (x.onclick = () => { S.meetMode = x.dataset.mm; render(); }));
  const send = async (fields) => {
    const [pid, track] = $("mt-where").value.split("|");
    const m = await api("/api/meeting", { project: pid, track, read: "auto", ...fields });
    S.meet[key] = m.id; toast("Saved. A session is reading it."); await refresh();
  };
  const pf = $("pasteform");
  if (pf) {
    const ta = $("pt-text"), go = $("pt-send");
    try { const d = sessionStorage.getItem("paste-draft"); if (d) { ta.value = d; go.disabled = false; } } catch {}
    ta.oninput = () => { go.disabled = !ta.value.trim(); try { sessionStorage.setItem("paste-draft", ta.value); } catch {} };
    pf.onsubmit = async (e) => {
      e.preventDefault(); if (!ta.value.trim()) return; go.disabled = true;
      try { await send({ title: $("pt-title").value.trim(), date: $("pt-date").value, text: ta.value }); try { sessionStorage.removeItem("paste-draft"); } catch {} }
      catch (err) { toast(err.message, true); go.disabled = false; }
    };
  }
  const drop = $("drop"), inp = $("mt-file");
  if (drop) {
    const take = async (f) => {
      if (!f) return;
      const ext = (f.name.match(/\.[^.]+$/) || [".txt"])[0].toLowerCase();
      const title = f.name.replace(/\.[^.]+$/, "").replace(/^\d{4}-\d{2}-\d{2}[_ -]?/, "").replace(/[_-]+/g, " ").trim();
      const date = (f.name.match(/^\d{4}-\d{2}-\d{2}/) || [iso(new Date())])[0];
      try {
        if (ext === ".docx") { const buf = new Uint8Array(await f.arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); await send({ title, date, docx: btoa(bin), text: " " }); }
        else await send({ title, date, ext, text: await f.text() });
      } catch (err) { toast(err.message, true); }
    };
    inp.onchange = () => take(inp.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
  }
  b.querySelectorAll("[data-m]").forEach((x) => (x.onclick = () => { S.meet[key] = x.dataset.m; render(); }));
  if (!cur) return;
  const { p: mp, m } = cur;
  const read = async (who) => { try { await api("/api/meeting/read", { project: mp.id, id: m.id, session: who }); toast("A session is reading it."); refresh(); } catch (e) { toast(e.message, true); } };
  if ($("mt-read")) $("mt-read").onclick = () => read($("mt-by").value);
  if ($("mt-reread")) $("mt-reread").onclick = () => read("auto");
}

/* ---------- Chats: side-by-side panes ---------- */
const paneKey = () => S.view + "|" + S.track;
const byState = (a, b) => ORDER[stateOf(a.s)] - ORDER[stateOf(b.s)] || (b.s.lastAt || 0) - (a.s.lastAt || 0);
function defaultPanes() {
  if (S.view === "today") return []; // Today opens chats only from its cards
  const p = proj(), list = allSessions();
  if (p) {
    const trs = S.track === "all" ? p.tracks : p.tracks.filter((t) => t.id === S.track);
    return trs.map((t) => list.filter((x) => x.s.track === t.id).sort(byState)[0]).filter(Boolean).map((x) => x.s.id);
  }
  return P().map((pp) => list.filter((x) => x.p === pp).sort(byState)[0]).filter(Boolean).sort(byState).slice(0, 3).map((x) => x.s.id);
}
function openPane(key, id) {
  const ps = (S.panes[key] ||= defaultPanes());
  if (!ps.includes(id)) { if (ps.length >= 4) { const i = ps.indexOf(S.focus[key]); ps[i < 0 ? ps.length - 1 : i] = id; } else ps.push(id); }
  S.focus[key] = id;
  if (S.tab !== "chats") S.tab = "chats";
  render();
}
function ensureMsgs(s, p) {
  const have = S.msgs[s.id];
  if (s.started === false) { S.msgs[s.id] = { at: 0, list: [] }; return; }
  if (have && (have.at === s.lastAt || have.loading)) return;
  S.msgs[s.id] = { ...(have || { list: null }), loading: true };
  api(`/api/messages?project=${p.id}&session=${encodeURIComponent(s.id)}`).then((r) => {
    S.msgs[s.id] = { at: s.lastAt, list: r.messages };
    if (r.streaming != null && !S.stream[s.id]?.active) S.stream[s.id] = { text: r.streaming, tool: "", active: true, queued: 0 };
    if (S.tab === "chats") render();
  }).catch(() => { S.msgs[s.id] = { at: s.lastAt, list: have?.list || [] }; });
}

function renderChats(b = $("body")) {
  const p = proj(), list = allSessions(), key = paneKey();
  if (!S.panes[key]) S.panes[key] = defaultPanes();
  // A remembered pane can point at a session that has since moved on (continued as a copy):
  // follow it by its earlier id, and fall back to the default panes if none are left.
  S.panes[key] = [...new Set(S.panes[key].map((id) => list.find((x) => x.s.id === id || (x.s.previousIds || []).includes(id))?.s.id).filter(Boolean))];
  if (!S.panes[key].length) S.panes[key] = defaultPanes();
  const panes = S.panes[key]; if (!panes.includes(S.focus[key])) S.focus[key] = panes[0];
  const col = !S.listOpen;
  let h = `<div class="chatwrap"><div class="slist${col ? " collapsed" : ""}"><div class="slhead">
    <button class="btn round" id="togglelist" aria-label="${col ? "Show the session list" : "Collapse the session list"}" title="${col ? "Show list" : "Collapse list"}">${col ? "»" : "«"}</button>
    <button class="btn ${col ? "round " : ""}primary" id="newsess" aria-label="New session" title="New session">${I.plus}${col ? "" : "New session"}</button></div>`;
  for (const pp of scopeP()) {
    const ss = list.filter((x) => x.p === pp).sort(byState);
    if (!ss.length && p) continue;
    if (!p) h += `<div class="grp">${esc(pp.name)}</div>`;
    if (!ss.length && !col) h += `<div class="hint" style="padding:4px 10px">No sessions</div>`;
    for (const { s } of ss) {
      const on = panes.includes(s.id), st = stateOf(s), tip = `${pp.name} · ${trName(pp, s.track)} · ${s.name}`;
      h += col
        ? `<button class="srow" data-s="${s.id}" aria-current="${on}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="av" style="background:${pp.color}">${esc(initials(s.name))}<span class="dot ${st}"></span></span></button>`
        : `<button class="srow" data-s="${s.id}" aria-current="${on}"><span class="dot ${st}"></span><span class="tx"><span class="nm"><span>${esc(s.name)}</span><span class="tm">${esc(clock(s.last?.at))}</span></span><span class="sub">${st === "waiting" ? '<span style="color:var(--warn)">New reply</span> · ' : ""}${esc(trName(pp, s.track))}</span><span class="pv">${s.last ? (s.last.who === "me" ? "You: " : "") + esc(s.last.text) : s.started === false ? "New, not started yet" : ""}</span>${on ? '<span class="open">Open</span>' : ""}</span></button>`;
    }
  }
  h += `</div>`;
  const listH = h.slice(`<div class="chatwrap">`.length);
  const sig = JSON.stringify([panes, col, !!S.sheet, !!list.length]);
  const wrap = b.querySelector(".chatwrap");
  if (wrap && wrap._sig === sig && !S.sheet) {
    const sl = wrap.querySelector(".slist");
    if (sl && sl._html !== listH) { const t = document.createElement("template"); t.innerHTML = listH; const n = t.content.firstElementChild; n._html = listH; sl.replaceWith(n); }
    for (const id of panes) {
      const x = findS(id); const sec = b.querySelector(`[data-pane="${CSS.escape(id)}"]`); if (!x || !sec) continue;
      const html = paneHTML(x, key), pp = S.paneParts[id];
      const m = sec.querySelector(".msgs"), mt = m?.querySelector(":scope > .mtail");
      if (sec._head !== pp.head || !m || !mt) { const t = document.createElement("template"); t.innerHTML = html; const n = t.content.firstElementChild; Object.assign(n, { _head: pp.head, _mh: pp.mh, _tail: pp.tail }); sec.replaceWith(n); continue; }
      // Same chat: add only the new messages (3 Nov 2026: rebuilding a 600-message chat while it replied
      // froze typing), swap the cards after them, and update the state, unread mark and Stop button.
      if (sec._mh !== pp.mh) { if (sec._mh && pp.mh.startsWith(sec._mh)) mt.insertAdjacentHTML("beforebegin", pp.mh.slice(sec._mh.length)); else { [...m.children].forEach((c) => c !== mt && c.remove()); mt.insertAdjacentHTML("beforebegin", pp.mh); } sec._mh = pp.mh; }
      if (sec._tail !== pp.tail) { mt.innerHTML = pp.tail; sec._tail = pp.tail; }
      const st = stateOf(x.s), live = S.stream[id]?.active, lab = sec.querySelector(".convhead .state");
      if (lab) { lab.className = `state ${st}`; lab.textContent = x.s.question ? "Asks you" : st === "working" ? "Working" : st === "waiting" ? "New reply" : "Idle"; }
      sec.classList.toggle("unread", st === "waiting"); sec.classList.toggle("focus", S.focus[key] === id && panes.length > 1);
      const form = sec.querySelector("[data-send]"), stop = form?.querySelector("[data-stop]");
      if (form && live && !stop) form.querySelector('button[aria-label="Send"]').insertAdjacentHTML("beforebegin", `<button type="button" class="btn stop" data-stop="${id}" aria-label="Stop" title="Stop">${I.stop}</button>`);
      if (stop && !live) stop.remove();
      const hl = sec.querySelector("[data-helpers]"); if (hl) hl.innerHTML = helpersHTML(id);
      const ch = sec.querySelector("[data-chips]"); if (ch) ch.innerHTML = chipsHTML(id);
    }
    wireChats(p, key);
    for (const id of panes) { const x = findS(id); if (x) { ensureMsgs(x.s, x.p); markSeen(x); loadAgents(x); } }
    return;
  }
  h += `<div class="panewrap">`;
  if (S.sheet) {
    h += `<form class="sheet" id="sheet"><label for="ns-name">What should it work on?<input id="ns-name" placeholder="e.g. Fix the booking reminder" maxlength="40" autocomplete="off"></label>
      <label for="ns-track">${p ? "Track" : "Project · track"}<select id="ns-track">${scopeP().flatMap((pp) => pp.tracks.map((t) => `<option value="${pp.id}|${t.id}"${S.track === t.id ? " selected" : ""}>${p ? "" : esc(pp.name) + " · "}${esc(t.name)}</option>`)).join("")}</select></label>
      <label for="ns-dir">Folder<input id="ns-dir" value="${esc((p || P()[0])?.folder || "~")}"></label>
      <div class="r"><button type="button" class="btn" id="ns-cancel">Cancel</button><button class="btn primary">Start session</button></div></form>`;
  }
  if (!panes.length && S.view === "today") h += `<div class="nochat">Press Chat on a card, or tick a few and press Chat about these: their chat opens here, next to your list.</div>`;
  else if (!panes.length) h += `<div class="nochat">${list.length ? "Pick sessions from the list to open them side by side." : "No sessions here yet.<br>Start one to work on something in parallel."}</div>`;
  else h += `<div class="panes">${panes.map((id) => paneHTML(findS(id), key)).join("")}</div>`;
  b.innerHTML = h + `</div></div>`;
  b.querySelector(".chatwrap")._sig = sig; const sl0 = b.querySelector(".slist"); if (sl0) sl0._html = listH;
  b.querySelectorAll("[data-pane]").forEach((x) => { const pp = S.paneParts?.[x.dataset.pane]; if (pp) Object.assign(x, { _head: pp.head, _mh: pp.mh, _tail: pp.tail }); });
  wireChats(p, key);
  for (const id of panes) { const x = findS(id); if (x) { ensureMsgs(x.s, x.p); markSeen(x); loadAgents(x); } }
}
function paneHTML({ p: sp, s }, key) {
  const label = `${sp.name} · ${trName(sp, s.track)}`; // shown on hover only: the pane header is just the session's name
  const st = stateOf(s), live = S.stream[s.id], msgs = S.msgs[s.id]?.list;
  const mh = msgs == null ? '<div class="m sys">Loading…</div>' : msgs.length ? msgs.map((m) => `<div class="m ${m.who}">${m.who === "me" ? meText(m.text) : mdKept(m.text)}${m.who === "claude" ? fileCards(sp, s, msgs, m) : ""}${m.who === "claude" && m.tools ? `<span class="steps">${m.tools} step${m.tools === 1 ? "" : "s"}</span>` : ""}<span class="when">${esc(clock(m.at))}</span></div>`).join("") : `<div class="m sys">${s.started === false ? `New session in ${esc(s.cwd)}. Say what you need; it starts with your first message.` : "Nothing said yet."}</div>`;
  let body = "";   // what follows the messages: refused steps, steps for Diogo, commands, the live reply
  for (const [i, d] of (s.denied || []).entries()) body += `<div class="m denied"><div class="dh"><b>Not allowed from the Desk</b><span>${esc(d.tool)} · ${esc(clock(d.at))}</span></div><div class="dd">${esc(d.detail)}</div>${d.command ? `<code class="dc">${esc(d.command.length > 300 ? d.command.slice(0, 300) + "…" : d.command)}</code>` : ""}<div class="dx">Steps that need your OK are refused when sent from the Desk.${d.command ? " Run it yourself, or tell the session how to go on." : " Tell the session how to go on."}</div><div class="db">${d.command ? `<button type="button" class="btn small" data-runit="${esc(s.id)}|${i}">Run it myself (!)</button>` : ""}<button type="button" class="linkbtn" data-undeny="${esc(sp.id)}|${esc(s.id)}|${i}">Dismiss</button></div></div>`;
  for (const a of s.asks || []) body += askCard(sp, s, a);
  if (s.question?.questions?.length && s.mine !== false) body += questionCard(sp, s, s.question);
  for (const e of s.pendingShell || []) body += `<div class="m shell"><div class="sh-h">${e.ask ? `<b>${esc(e.ask)}</b>` : `<code>$ ${esc(e.cmd)}</code>`}<span>${e.state === "running" ? (e.ask ? "follow the window that opened…" : "running in Terminal…") : e.ask ? "done · the session carries on" : `exit ${e.code ?? "?"} · goes with your next message`}</span></div>${e.state === "done" && !e.ask ? `<pre>${esc(e.output || "(no output)")}</pre>` : ""}</div>`;
  // A job the session left running past its reply (`desk wait`): it shows here until it ends, then the session reports.
  if (!live?.active) for (const b of s.bg || []) body += `<div class="m claude streaming bgjob"><span class="workline"><span class="typing"><i></i><i></i><i></i></span><span class="wk">Working in the background · ${esc(b.what)} · since ${esc(clock(b.at))}</span></span><span class="bgnote">${esc(s.name)} will report here when it ends.</span></div>`;
  if (live?.active) body += `<div class="m claude streaming" data-live="${esc(s.id)}"><span class="tx">${md(unsaid(live.text, msgs))}</span><span class="workline"><span class="typing"><i></i><i></i><i></i></span><span class="wk">${esc(workLine(live))}</span></span><ul class="feed">${feedHTML(live)}</ul></div>`;
  // Kept so a redraw can add just the new messages and swap just the cards after them (renderChats).
  (S.paneParts ||= {})[s.id] = { mh, tail: body, head: JSON.stringify([s.name, s.cwd, s.mine, D.voice]) };
  body = mh + `<div class="mtail">${body}</div>`;
  return `<section class="pane-c${S.focus[key] === s.id && S.panes[key].length > 1 ? " focus" : ""}${st === "waiting" ? " unread" : ""}" data-pane="${s.id}">
   <div class="convhead"><div class="l"><span class="sw" style="background:${sp.color}" title="${esc(label)}"></span>
     <input class="sname" data-rn="${s.id}" data-p="${sp.id}" id="sn-${s.id}" value="${esc(s.name)}" aria-label="Session name" maxlength="40" title="${esc(s.cwd)}"></div>
     <div class="hr"><span class="state ${st}">${s.question ? "Asks you" : st === "working" ? "Working" : st === "waiting" ? "New reply" : "Idle"}</span><button class="x" data-close="${s.id}" aria-label="Close this pane" title="Close pane">×</button></div></div>
   <div class="msgs" data-for="${s.id}">${body}</div>
   <div class="helpers" data-helpers="${esc(s.id)}">${helpersHTML(s.id)}</div>
   <div class="chips" data-chips="${esc(s.id)}">${chipsHTML(s.id)}</div>
   ${s.mine === false ? `<div class="rofoot">${esc(s.owner)}'s session · it runs on ${esc(s.owner)}'s computer, so only ${esc(s.owner)} can write here. Start your own with + New session.</div></section>` : ""}${s.mine === false ? "" : `<form class="composer" data-send="${s.id}" data-p="${sp.id}"><button type="button" class="btn round clip" data-clip="${esc(s.id)}" aria-label="Attach files" title="Attach photos, documents, videos…">${I.clip}</button>${D.voice ? `<button type="button" class="btn round mic" data-mic="${esc(s.id)}" aria-label="Hold to talk" title="Hold to talk: speak, let go, and the words go into the box">${I.mic}</button>` : ""}<input type="file" multiple hidden data-file="${esc(s.id)}"><textarea id="say-${s.id}" rows="1" placeholder="Message ${esc(s.name)}…"></textarea>${live?.active ? `<button type="button" class="btn stop" data-stop="${s.id}" aria-label="Stop" title="Stop">${I.stop}</button>` : ""}<button class="btn primary" aria-label="Send" disabled>${I.send}</button></form></section>`}`;
}
/* ---------- Claude's questions (its AskUserQuestion tool), answered with buttons ----------
   bin/claude-keeper.mjs holds the question while Diogo picks; one question with one choice sends on the
   tap, several (or several choices) need Send answers. Typing a message instead answers it in words. */
const qMulti = (q) => q.questions.length > 1 || q.questions.some((x) => x.multiSelect);
function questionCard(sp, s, q) {
  const sel = ((S.qsel ||= {})[s.id] ||= {});
  const on = (x, o) => (x.multiSelect ? (sel[x.question] || []).includes(o.label) : sel[x.question] === o.label);
  return `<div class="m question"><span class="qtop">${esc(s.name)} asks</span>` + q.questions.map((x, qi) => `<div class="qq">${x.header ? `<span class="qh">${esc(x.header)}</span>` : ""}<b>${esc(x.question)}</b>${x.multiSelect ? '<span class="qh">pick any</span>' : ""}<div class="qopts">${(x.options || []).map((o, oi) => `<button type="button" class="qopt${on(x, o) ? " on" : ""}" data-qopt="${esc(sp.id)}|${esc(s.id)}|${qi}|${oi}"><span>${esc(o.label)}</span>${o.description && o.description !== o.label ? `<small>${esc(o.description)}</small>` : ""}</button>`).join("")}</div></div>`).join("")
    + (qMulti(q) ? `<div class="db"><button type="button" class="btn primary small" data-qsend="${esc(sp.id)}|${esc(s.id)}">Send answers</button></div>` : "") + `<span class="qhint">Or type your own answer in the box below.</span></div>`;
}
function pickAnswer(k) {
  const [pid, sid, qi, oi] = k.split("|"), x = findS(sid); const q = x?.s.question; if (!q) return;
  const qq = q.questions[+qi], o = qq.options[+oi], sel = ((S.qsel ||= {})[sid] ||= {});
  if (qq.multiSelect) { const a = new Set(sel[qq.question] || []); a.has(o.label) ? a.delete(o.label) : a.add(o.label); sel[qq.question] = [...a]; }
  else sel[qq.question] = o.label;
  if (!qMulti(q)) return sendAnswers(pid, sid);
  render();
}
async function sendAnswers(pid, sid) {
  const x = findS(sid), q = x?.s.question; if (!q) return;
  const sel = (S.qsel || {})[sid] || {}, answers = {};
  for (const qq of q.questions) { const v = sel[qq.question]; if (!v || (Array.isArray(v) && !v.length)) return toast(`Pick an answer for: ${qq.question}`, true); answers[qq.question] = Array.isArray(v) ? v.join(", ") : v; }
  try { await api("/api/answer", { project: pid, session: sid, request_id: q.request_id, answers }); delete S.qsel[sid]; x.s.question = null; render(); }
  catch (e) { toast(e.message, true); refresh(); }
}

/* ---------- Steps only Diogo can do (`desk ask`): a card in the pane, and a pop-up when one is new ---------- */
const askBtn = (a) => (a.cmd ? (a.kind === "login" ? "Sign in" : "Do it") : "Open it");
function askCard(sp, s, a) {
  const k = `${sp.id}|${s.id}|${a.id}`;
  return `<div class="m ask"><b>${esc(a.title)}</b>${a.why ? `<div class="aw">${esc(a.why)}</div>` : ""}<div class="db"><button type="button" class="btn primary small" data-ask="${k}|${a.cmd ? "run" : "open"}">${askBtn(a)}</button>${a.url ? `<button type="button" class="btn small" data-ask="${k}|done">I've done it</button>` : ""}<button type="button" class="linkbtn" data-ask="${k}|dismiss">Not needed</button></div></div>`;
}
async function answerAsk(pid, sid, id, answer) {
  let r; try { r = await api("/api/ask", { project: pid, session: sid, id, answer }); } catch (e) { return toast(e.message, true); }
  if (answer === "open") { toast("Opened. Click \u201cI've done it\u201d when you're finished."); return; }
  $("askpop")?.remove();
  if (answer === "run" && r?.id) { S.askRun = r; askRunPop(); }
  refresh();
}
const askSeen = (() => { try { return new Set(JSON.parse(localStorage.getItem("asks-seen") || "[]")); } catch { return new Set(); } })();
function askPop(inner, label) {
  $("askpop")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="askpop" role="dialog" aria-label="${esc(label)}"><div class="vbox glass small askbox">${inner}</div></div>`);
  const pop = $("askpop");
  pop.querySelectorAll("[data-close-pop]").forEach((x) => (x.onclick = () => pop.remove()));
  pop.onclick = (e) => { if (e.target === pop) pop.remove(); };
  return pop;
}
function checkAsks() {
  if ($("askpop") || $("viewer")) return;
  for (const p of P()) for (const s of p.sessions) for (const a of s.asks || []) {
    if (askSeen.has(a.id) || s.mine === false) continue;
    askSeen.add(a.id); try { localStorage.setItem("asks-seen", JSON.stringify([...askSeen].slice(-200))); } catch {}
    notify(`${p.name} · ${s.name}`, a.title, s.id);
    const k = `${p.id}|${s.id}|${a.id}`;
    const pop = askPop(`<div class="vhead"><div class="vt"><b>${esc(a.title)}</b><span>${esc(p.name)} · ${esc(s.name)}</span></div><button class="x" data-close-pop aria-label="Close">×</button></div><div class="askbody">${a.why ? `<p>${esc(a.why)}</p>` : ""}<div class="db"><button type="button" class="btn primary" data-ask="${k}|${a.cmd ? "run" : "open"}">${askBtn(a)}</button>${a.url ? `<button type="button" class="btn" data-ask="${k}|done">I've done it</button>` : ""}<button type="button" class="linkbtn" data-close-pop>Later</button></div></div>`, a.title);
    pop.querySelectorAll("[data-ask]").forEach((x) => (x.onclick = () => { const [pid, sid, id, answer] = x.dataset.ask.split("|"); answerAsk(pid, sid, id, answer); }));
    return;
  }
}
// While a step's command runs (hidden): what it's waiting for, any link or code it printed, a box to
// answer it, and Cancel. Closes by itself when it ends; the session then carries on.
function askRunPop() {
  const r = S.askRun; if (!r) return;
  const out = r.out || "", lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const links = [...new Set(out.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])].slice(-3);
  const code = (out.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g) || []).pop();
  const status = r.done ? (r.cancelled ? "Cancelled." : r.code === 0 ? "Done. The session carries on by itself." : "It didn't finish. The session has been told and will say what's next.") : r.waiting ? "It's asking something:" : links.length ? "Finish in the browser page that opened (or open it below)." : "Working… a browser page may open: follow it there.";
  const last = lines.slice(-1)[0] || "";
  const keep = $("askin")?.value || "";
  const pop = askPop(`<div class="vhead"><div class="vt"><b>${esc(r.title)}</b><span>${r.done ? "finished" : "in progress"}</span></div><button class="x" data-close-pop aria-label="Close">×</button></div><div class="askbody"><p>${esc(status)}</p>${!r.done && r.waiting ? `<p class="askq">${esc(last)}</p><form class="db" id="askform"><input class="askin" id="askin" autocomplete="off" value="${esc(keep)}"><button class="btn primary" type="submit">Send</button></form>` : ""}${code && !r.done ? `<p class="askcode">Code: <b>${esc(code)}</b></p>` : ""}${!r.done && links.length ? `<div class="db">${links.map((u) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">Open ${esc(new URL(u).hostname)}</a>`).join("")}</div>` : ""}${!r.done ? `<div class="db"><button type="button" class="linkbtn" id="askcancel">Cancel</button><button type="button" class="linkbtn" data-close-pop>Hide</button></div>` : ""}${last && !r.waiting ? `<p class="asklast">${esc(last.slice(0, 200))}</p>` : ""}</div>`, r.title);
  $("askform")?.addEventListener("submit", async (e) => { e.preventDefault(); const v = $("askin").value; $("askin").value = ""; try { await api("/api/askinput", { run: r.id, text: v }); } catch (er) { toast(er.message, true); } });
  if ($("askin")) $("askin").focus();
  if ($("askcancel")) $("askcancel").onclick = () => api("/api/askcancel", { run: r.id }).catch(() => {});
  if (r.done) setTimeout(() => { if (S.askRun === r) { $("askpop")?.remove(); S.askRun = null; } }, r.code === 0 ? 1800 : 6000);
}

/* ---------- Today: what waits on Diogo, across projects (Diogo, 5 Nov 2026) ----------
   It stays on the page (a closed pop-up lost the list). Each card has Done and Chat; ticking several
   and pressing "Chat about these" opens their chats next to the list, each with its cards in the box.
   Same order as the morning message (lib/morning.mjs): late (oldest first), this week, then undated. */
S.tsel = new Set();
function todayCards() {
  const d = iso(TODAY()), days = (a) => Math.round((Date.parse(a) - Date.parse(d)) / 864e5);
  const xs = P().filter((p) => kindOf(p) !== "sales").flatMap((p) => p.todos.filter((t) => needsMe(t) && t.status !== "ongoing").map((t) => ({ p, t })));
  const late = xs.filter((x) => x.t.due && x.t.due < d).sort((a, b) => a.t.due.localeCompare(b.t.due));
  const soon = xs.filter((x) => x.t.due && x.t.due >= d && days(x.t.due) <= 8).sort((a, b) => a.t.due.localeCompare(b.t.due));
  const rest = xs.filter((x) => !late.includes(x) && !soon.includes(x)).sort((a, b) => (a.t.due ? 1 : 0) - (b.t.due ? 1 : 0) || (a.t.priority || 2) - (b.t.priority || 2) || String(a.t.createdAt || "").localeCompare(String(b.t.createdAt || "")));
  return { late, soon, rest, d };
}
// The chat a card belongs to: its own, else its track's chat (as the morning run does).
function cardChat(p, t) {
  const own = t.session && p.sessions.find((s) => (s.id === t.session || (s.previousIds || []).includes(t.session)) && s.mine !== false);
  return own || p.sessions.find((s) => s.track === t.track && s.mine !== false) || p.sessions.find((s) => s.mine !== false) || null;
}
function todayRow({ p, t }, d) {
  const k = `${p.id}|${t.id}`, late = t.due && t.due < d ? Math.round((Date.parse(d) - Date.parse(t.due)) / 864e5) : 0;
  const when = late ? `<i class="late">${late} day${late === 1 ? "" : "s"} late</i>` : t.due ? `<i>due ${esc(fmtShort(t.due))}</i>` : "";
  return `<div class="trow${S.tsel.has(k) ? " sel" : ""}" data-tk="${esc(k)}"><input type="checkbox" class="tck" data-tck="${esc(k)}" aria-label="Select" ${S.tsel.has(k) ? "checked" : ""}>
    <div class="tx"><span class="tp"><span class="sw" style="background:${p.color}"></span>${esc(p.name)} · ${esc(trName(p, t.track))}</span><span class="tt">${esc(t.title)}</span><span class="tw">${[when, t.reach ? '<b class="myes">your yes</b>' : "", t.status === "blocked" && t.why ? esc(t.why) : ""].filter(Boolean).join(" · ")}</span></div>
    <div class="tb"><button class="btn small" data-tchat="${esc(k)}" title="Talk to its chat about it">Chat</button><button class="btn small" data-tdone="${esc(k)}" title="Mark it done">Done</button></div></div>`;
}
function renderToday() {
  const { late, soon, rest, d } = todayCards();
  const n = late.length + soon.length + rest.length;
  for (const k of [...S.tsel]) { const [pid, id] = k.split("|"); if (!P().find((p) => p.id === pid)?.todos.some((t) => t.id === id && needsMe(t))) S.tsel.delete(k); }
  const sec = (title, xs) => (xs.length ? `<div class="tsec">${title}</div>` + xs.map((x) => todayRow(x, d)).join("") : "");
  const bar = S.tsel.size ? `<div class="tbar"><b>${S.tsel.size} selected</b><button class="btn primary small" id="tchatsel">Chat about these</button><button class="btn small" id="tdonesel">Done</button><button class="linkbtn" id="tclear">Clear</button></div>` : "";
  const list = `<div class="tlist">${bar}${n ? sec("Late", late) + sec("This week", soon) + sec("No date", rest) : '<div class="empty">Nothing waits on you. ☀</div>'}${S.morning?.sent?.length && S.morning.date === d ? `<p class="mfoot">This morning, late work went back to ${S.morning.sent.length} chat${S.morning.sent.length === 1 ? "" : "s"}.</p>` : ""}</div>`;
  const top = `<div class="top"><h1>Today</h1><span class="tsub">${n ? `${n} thing${n === 1 ? "" : "s"} wait on you` : ""}</span></div><div class="body chat-body today-body" id="body"><div class="todaywrap"><div id="tlistwrap"></div><div id="tchats"></div></div></div>`;
  if ($("main")._top !== top || !$("tchats")) { $("main").innerHTML = top; $("main")._top = top; }
  $("tlistwrap").innerHTML = list;
  renderChats($("tchats"));
  wireToday();
}
function wireToday() {
  const L = $("tlistwrap"), find = (k) => { const [pid, id] = k.split("|"); const p = P().find((x) => x.id === pid); return { p, t: p?.todos.find((x) => x.id === id) }; };
  L.querySelectorAll("[data-tck]").forEach((c) => (c.onchange = () => { c.checked ? S.tsel.add(c.dataset.tck) : S.tsel.delete(c.dataset.tck); render(); }));
  L.querySelectorAll("[data-tchat]").forEach((b) => (b.onclick = () => chatAbout([b.dataset.tchat])));
  L.querySelectorAll("[data-tdone]").forEach((b) => (b.onclick = () => doneCards([b.dataset.tdone])));
  if ($("tchatsel")) $("tchatsel").onclick = () => chatAbout([...S.tsel]);
  if ($("tdonesel")) $("tdonesel").onclick = () => doneCards([...S.tsel]);
  if ($("tclear")) $("tclear").onclick = () => { S.tsel.clear(); render(); };
  async function doneCards(keys) {
    const was = keys.map((k) => ({ k, ...find(k) })).filter((x) => x.t);
    for (const x of was) await op("todo.set", x.p.id, { id: x.t.id, status: "done" }).catch((e) => toast(e.message, true));
    for (const k of keys) S.tsel.delete(k);
    await refresh();
    toastUndo(`${was.length === 1 ? "Done: " + was[0].t.title : was.length + " cards done"}`, async () => { for (const x of was) await op("todo.set", x.p.id, { id: x.t.id, status: x.t.status, ...(x.t.status === "waiting" ? { waitingOn: x.t.waitingOn } : {}) }).catch(() => {}); refresh(); });
  }
  // Each chat gets the cards that belong to it, in its message box, ready to add a word and send.
  function chatAbout(keys) {
    const by = new Map();
    for (const k of keys) { const { p, t } = find(k); if (!t) continue; const s = cardChat(p, t); if (!s) { toast(`${p.name} has no chat on this computer for “${t.title}”.`, true); continue; } (by.get(s.id) || by.set(s.id, []).get(s.id)).push(t); }
    if (!by.size) return;
    const key = paneKey();
    for (const [sid, ts] of by) {
      const text = (ts.length === 1 ? `About this card on the board: [${ts[0].id}] ${ts[0].title}` : `About these cards on the board:\n${ts.map((t) => `- [${t.id}] ${t.title}`).join("\n")}`) + "\n\n";
      let cur = ""; try { cur = sessionStorage.getItem("draft-" + sid) || ""; } catch {}
      const next = cur.includes(text.trim()) ? cur : cur ? cur.trimEnd() + "\n\n" + text : text;
      try { sessionStorage.setItem("draft-" + sid, next); } catch {}
      const ta = $("say-" + sid); if (ta) { ta.value = next; ta.dispatchEvent(new Event("input")); }
      const ps = (S.panes[key] ||= []);
      if (!ps.includes(sid)) { if (ps.length >= 3) ps.shift(); ps.push(sid); }
      S.focus[key] = sid;
    }
    S.tsel.clear(); render();
    const first = [...by.keys()][0]; setTimeout(() => { const ta = $("say-" + first); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 50);
  }
}
// The morning opens Today once a day (no pop-up: closing it lost the list).
async function showMorning() {
  let m; try { m = await api("/api/morning"); } catch { return; }
  S.morning = m;
  if (!m || m.date !== iso(TODAY())) return;
  let seen = ""; try { seen = localStorage.getItem("today-seen") || ""; } catch {}
  if (seen === m.date) { if (S.view === "today") render(); return; }
  try { localStorage.setItem("today-seen", m.date); } catch {}
  S.view = "today"; render();
}
setTimeout(() => showMorning(), 1500);
window.addEventListener("focus", () => showMorning());

/* ---------- Helper agents (subagents) at the bottom of each pane ---------- */
const dur = (a, b) => { const s = Math.max(0, Math.round((new Date(b || Date.now()) - new Date(a)) / 1000)); if (!a || isNaN(s)) return ""; return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
function helpersHTML(sid) {
  const list = S.agents[sid];
  if (!list || !list.length) return "";
  const run = list.filter((a) => a.state === "running"), done = list.filter((a) => a.state === "done").length, stop = list.filter((a) => a.state === "stopped").length;
  const open = S.helpersOpen[sid] ?? run.length > 0;
  const sum = [run.length ? `<b>${run.length} running</b>` : "", done ? `${done} done` : "", stop ? `${stop} stopped` : ""].filter(Boolean).join(" · ");
  // children sit under the helper that started them
  const top = list.filter((a) => !a.parent || !list.some((b) => b.id === a.parent));
  const rows = [];
  const add = (a, lvl) => { rows.push([a, lvl]); for (const c of list.filter((x) => x.parent === a.id)) add(c, lvl + 1); };
  top.forEach((a) => add(a, 0));
  return `<button class="hhead${run.length ? " live" : ""}" data-htoggle="${esc(sid)}" aria-expanded="${open}"><span class="hico">${run.length ? '<i class="spin"></i>' : I.check}</span><span class="hlabel">Helpers</span><span class="hsum">${sum} <span class="hwhen">today</span></span><span class="chev">${open ? "▾" : "▸"}</span></button>`
    + (open ? `<ul class="hlist">${rows.map(([a, lvl]) => `<li class="h ${a.state}" style="--lvl:${lvl}" title="${esc(a.type)}${a.background ? " · in the background" : ""}"><span class="hst">${a.state === "running" ? '<i class="spin"></i>' : a.state === "done" ? I.check : "–"}</span><span class="hd">${lvl ? '<span class="sub">↳</span>' : ""}${esc(a.description)}${a.state === "running" && a.doing ? `<span class="doing">${esc(a.doing)}</span>` : ""}</span><span class="ht">${esc(a.type.replace("general-purpose", "general"))}</span><span class="htime">${a.state === "running" ? dur(a.startedAt) : a.state === "done" ? dur(a.startedAt, a.endedAt) : "stopped"}</span></li>`).join("")}</ul>` : "");
}
function paintHelpers(sid) {
  const el = document.querySelector(`[data-helpers="${CSS.escape(sid)}"]`);
  if (el) { el.innerHTML = helpersHTML(sid); wireHelpers(el); }
}
function wireHelpers(root) {
  root.querySelectorAll("[data-htoggle]").forEach((b) => (b.onclick = () => { const id = b.dataset.htoggle; const run = (S.agents[id] || []).some((a) => a.state === "running"); S.helpersOpen[id] = !(S.helpersOpen[id] ?? run); paintHelpers(id); }));
}
async function loadAgents({ p, s }, force) {
  if (s.started === false) return;
  if (!force && Date.now() - (S.agentsAt[s.id] || 0) < 3000) return;
  S.agentsAt[s.id] = Date.now();
  try {
    const r = await api(`/api/agents?project=${p.id}&session=${encodeURIComponent(s.id)}`);
    const before = JSON.stringify(S.agents[s.id] || []);
    S.agents[s.id] = r.agents;
    if (JSON.stringify(r.agents) !== before) { const was = before.includes('"running"'), now = r.agents.some((a) => a.state === "running"); if (was !== now) render(); else paintHelpers(s.id); }
  } catch {}
}
// While Chats is open, keep the strips current: running helpers tick, finished ones turn green.
setInterval(() => {
  if (S.tab !== "chats" || document.hidden) return;
  for (const id of S.panes[paneKey()] || []) { const x = findS(id); if (x) loadAgents(x, true); }
  document.querySelectorAll(".h.running .htime").forEach((el) => { const li = el.closest("[data-helpers]"); if (li) paintHelpers(li.dataset.helpers); });
}, 4000);

/* ---------- Project brief and new projects ---------- */
async function openBrief(p) {
  let r; try { r = await api(`/api/brief?project=${p.id}`); } catch (e) { return toast(e.message, true); }
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="viewer" role="dialog" aria-label="${esc(p.name)} brief"><div class="vbox glass"><div class="vhead"><div class="vt"><b>${esc(p.name)} · brief</b><span>${esc(r.path)} · every session reads this first and keeps it current</span></div><button class="btn" id="bopen">Open to edit</button><button class="x" id="vclose" aria-label="Close">×</button></div><div class="vbody"><div class="brief-md m">${md(r.text || "(empty)")}</div></div></div></div>`);
  const v = $("viewer"), close = () => v.remove();
  v.onclick = (e) => { if (e.target === v) close(); }; $("vclose").onclick = close;
  $("bopen").onclick = () => api("/api/briefopen", { project: p.id }).catch((e) => toast(e.message, true));
}
const SWATCHES = ["#7c3aed", "#0071e3", "#9a7633", "#0f766e", "#d93025", "#ea8a00", "#db2777", "#4f46e5", "#16a34a", "#475569"];
function newProject(kind = "project") {
  const client = kind === "client", what = client ? "client" : "project";
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="viewer" role="dialog" aria-label="New project"><form class="vbox glass small npform" id="npform">
    <div class="vhead"><div class="vt"><b>New ${what}</b><span>${client ? "Shared with " + (ME === "Diogo" ? "João" : "Diogo") + ": roadmap, board, numbers, meetings, files, chats and a brief." : "It gets its own roadmap, board, numbers, meetings, files, sessions and a brief."}</span></div><button type="button" class="x" id="vclose" aria-label="Close">×</button></div>
    <div class="npbody">
      <label for="np-name">Name<input id="np-name" required maxlength="40" placeholder="e.g. Crumb and Co" autocomplete="off"></label>
      <label for="np-folder">Folder on this computer<span class="np-pick"><input id="np-folder" required placeholder="~/Projects/crumb-and-co" autocomplete="off"><button type="button" class="btn" id="np-choose">Choose…</button></span><small>Where its work lives; sessions start here. If it doesn't exist yet, it's created.</small></label>
      <label for="np-tracks">Tracks<input id="np-tracks" placeholder="e.g. Website, Ads, Social" autocomplete="off"><small>Comma-separated. Leave empty for one track; you can add and rename them later.</small></label>
      <div class="nprow"><span class="lbl">Colour</span><span class="swatches">${SWATCHES.map((c, i) => `<button type="button" class="sw-pick" data-c="${c}" aria-pressed="${i === 0}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</span></div>
      <label for="np-logo">Logo (optional)<input type="file" id="np-logo" accept="image/png,image/jpeg,image/svg+xml,image/webp"></label>
    </div>
    <div class="npfoot"><button type="button" class="btn" id="np-cancel">Cancel</button><button class="btn primary" id="np-go">Create ${what}</button></div></form></div>`);
  const v = $("viewer"), close = () => v.remove();
  let color = SWATCHES[0];
  v.querySelectorAll(".sw-pick").forEach((b) => (b.onclick = () => { color = b.dataset.c; v.querySelectorAll(".sw-pick").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); }));
  $("vclose").onclick = close; $("np-cancel").onclick = close; v.onclick = (e) => { if (e.target === v) close(); };
  $("np-name").oninput = () => { const f = $("np-folder"); if (!f.dataset.touched) f.value = (client ? "~/Blendd/" : "~/Projects/") + $("np-name").value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); };
  $("np-folder").oninput = () => { $("np-folder").dataset.touched = "1"; };
  $("np-choose").onclick = async () => { try { const r = await api("/api/pick-folder", {}); if (r.folder) { $("np-folder").value = r.folder; $("np-folder").dataset.touched = "1"; } else if (r.why) toast(r.why); } catch (err) { toast(err.message, true); } };
  $("np-name").focus();
  $("npform").onsubmit = async (e) => {
    e.preventDefault(); $("np-go").disabled = true;
    try {
      const p = await api("/api/project", { name: $("np-name").value, folder: $("np-folder").value, tracks: $("np-tracks").value, color, kind });
      const logo = $("np-logo").files[0];
      if (logo) { const r = await fetch(`/api/logo?project=${p.id}`, { method: "POST", headers: { "Content-Type": logo.type }, body: logo }); if (!r.ok) toast((await r.json()).error || "The logo didn't upload.", true); }
      close(); await refresh(); S.view = p.id; S.track = "all"; S.tab = "chats"; render(); toast(client ? `${p.name} is in Clients, shared. Each track has a chat ready.` : `${p.name} is on the Desk. Each track has a chat ready.`);
    } catch (err) { toast(err.message, true); $("np-go").disabled = false; }
  };
}

/* ---------- Files: what Claude made ---------- */
const KINDS = [["all", "All"], ["pdf", "PDFs"], ["doc", "Documents"], ["sheet", "Sheets"], ["slides", "Slides"], ["image", "Images"], ["video", "Videos"], ["html", "Pages"], ["artifact", "Artifacts"], ["print", "Print files"], ["text", "Notes"], ["other", "Other"]];
const KLABEL = Object.fromEntries(KINDS);
const fq = (p, f) => `project=${encodeURIComponent(p.id)}&id=${encodeURIComponent(f.id)}`;
const fsrc = (p, f) => `/f/${encodeURIComponent(p.id)}/${encodeURIComponent(f.id)}/${encodeURIComponent(f.path.split("/").pop())}`;
const fileName = (f) => f.url ? "claude.ai artifact" : f.path.split("/").pop();
function fileThumb(p, f) {
  if (f.kind === "artifact") return `<span class="fthumb art"><span>✦</span></span>`;
  if (f.kind === "image") return `<span class="fthumb"><img src="${fsrc(p, f)}" alt="" loading="lazy"></span>`;
  if (/\.stl$/i.test(f.path)) return `<span class="fthumb" data-stl="${fsrc(p, f)}">${STILLS.get(fsrc(p, f)) ? `<img src="${STILLS.get(fsrc(p, f))}" alt="">` : "<b>stl</b>"}</span>`;
  const badge = (fileName(f).match(/\.([^.]+)$/) || ["", "file"])[1].slice(0, 4);
  return `<span class="fthumb"><img src="/api/thumb?${fq(p, f)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('b'),{textContent:'${esc(badge)}'}))"></span>`;
}
function fileCard(p, f, small) {
  return `<button class="fcard${small ? " small" : ""}" data-fopen="${esc(p.id)}|${esc(f.id)}" title="${esc(f.url || f.path)}">${fileThumb(p, f)}<span class="fmeta"><span class="ft">${esc(f.title)}</span><span class="fs">${esc(KLABEL[f.kind] || "File")} · ${fmt(f.at)}${small ? "" : ` · ${esc(p.sessions.find((s) => s.id === f.session || (s.previousIds || []).includes(f.session))?.name || trName(p, f.track))}`}</span></span></button>`;
}
// Under a reply: the files registered between the message before it and shortly after it.
function fileCards(p, s, msgs, m) {
  const ids = [s.id, ...(s.previousIds || [])], i = msgs.indexOf(m), t = Date.parse(m.at) || 0;
  const from = i > 0 ? Date.parse(msgs[i - 1].at) || 0 : 0, to = (i < msgs.length - 1 ? Date.parse(msgs[i + 1].at) : Date.now()) || Date.now();
  const fs = (p.files || []).filter((f) => ids.includes(f.session) && Date.parse(f.at) > from && Date.parse(f.at) <= Math.min(to, t + 10 * 60e3));
  return fs.length ? `<span class="fcards">${fs.map((f) => fileCard(p, f, true)).join("")}</span>` : "";
}
function renderFiles() {
  const b = $("body");
  const all = scopeP().flatMap((p) => (p.files || []).filter(inTrack).map((f) => ({ p, f }))).sort((a, c) => c.f.at.localeCompare(a.f.at));
  const has = new Set(all.map((x) => x.f.kind));
  const list = all.filter((x) => S.fkind === "all" || x.f.kind === S.fkind);
  let h = `<div class="tools"><div class="filters">${KINDS.filter(([k]) => k === "all" || has.has(k)).map(([k, l]) => `<button class="chip" data-fk="${k}" aria-pressed="${S.fkind === k}">${l}</button>`).join("")}</div></div>`;
  h += list.length ? `<div class="fgrid">${list.map(({ p, f }) => fileCard(p, f, false)).join("")}</div>` : `<div class="empty">Nothing here yet. Whatever Claude makes for this project — documents, PDFs, images, print files, artifacts — appears here.</div>`;
  b.innerHTML = h;
  b.querySelectorAll("[data-fk]").forEach((x) => (x.onclick = () => { S.fkind = x.dataset.fk; render(); }));
}
// Delete asks twice: the first press turns the button into a confirmation, which expires in 5 s.
function wireDelete(v, p, f, close) {
  const b = v.querySelector("#vdel"); let armed = false, t;
  b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = f.url ? "Remove from Files?" : "Move to Trash?"; b.classList.add("armed"); t = setTimeout(() => { armed = false; b.textContent = "Delete"; b.classList.remove("armed"); }, 5000); return; }
    clearTimeout(t); b.disabled = true;
    try { const r = await api("/api/filedelete", { project: p.id, id: f.id }); close(); toast(r.trashed ? "Moved to the Trash. You can put it back from there." : "Removed from Files."); refresh(); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  };
}
// Artifacts can't be shown inside the Desk (claude.ai doesn't allow it): a small sheet to open or remove.
function openArtifact(p, f) {
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="viewer" role="dialog" aria-label="${esc(f.title)}"><div class="vbox glass small"><div class="vhead"><div class="vt"><b>${esc(f.title)}</b><span>${esc(f.url)}</span></div><a class="btn primary" href="${esc(f.url)}" target="_blank" rel="noopener">Open on claude.ai</a><button class="btn danger" id="vdel">Delete</button><button class="x" id="vclose" aria-label="Close">×</button></div></div></div>`);
  const v = $("viewer"), close = () => { v.remove(); document.removeEventListener("keydown", esck); };
  const esck = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esck); v.onclick = (e) => { if (e.target === v) close(); }; $("vclose").onclick = close;
  wireDelete(v, p, f, close);
}

// STL stills, drawn in the page with three.js once each and remembered while the page is open.
const STILLS = new Map();
let stlIO = null;
function hydrateSTL() {
  const els = document.querySelectorAll("[data-stl]:not([data-done])");
  if (!els.length) return;
  stlIO ||= new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return; const el = e.target; stlIO.unobserve(el);
    const url = el.dataset.stl;
    import("/stl.mjs").then((m) => m.snapshotSTL(url)).then((data) => { STILLS.set(url, data); document.querySelectorAll(`[data-stl="${CSS.escape(url)}"]`).forEach((x) => (x.innerHTML = `<img src="${data}" alt="">`)); }).catch(() => {});
  }), { rootMargin: "200px" });
  els.forEach((el) => { el.dataset.done = "1"; if (STILLS.has(el.dataset.stl)) return; stlIO.observe(el); });
}
new MutationObserver(() => hydrateSTL()).observe(document.body, { childList: true, subtree: true });

// The large viewer: previews what the browser can show; everything gets Open / Show in Finder.
function openViewer(pid, id) {
  const p = P().find((x) => x.id === pid), f = p?.files?.find((x) => x.id === id); if (!f) return;
  if (f.url) return openArtifact(p, f);
  const src = fsrc(p, f);
  const body = f.kind === "image" ? `<img src="${src}" alt="">`
    : f.kind === "pdf" ? `<iframe src="${src}" title="${esc(f.title)}"></iframe>`
    : f.kind === "html" ? `<iframe src="${src}" sandbox="allow-scripts allow-popups allow-forms" title="${esc(f.title)}"></iframe>`
    : f.kind === "video" ? `<video src="${src}" controls autoplay></video>`
    : f.kind === "text" ? `<pre class="vtext">Loading…</pre>`
    : /\.stl$/i.test(f.path) ? `<div class="v3d" id="v3d"><p class="hint">Loading the model…</p></div>`
    : `<img class="vthumb" src="/api/thumb?${fq(p, f)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'hint',textContent:'No preview for this kind of file. Open it in its app.'}))">`;
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="viewer" role="dialog" aria-label="${esc(f.title)}"><div class="vbox glass"><div class="vhead"><div class="vt"><b>${esc(f.title)}</b><span>${esc(f.path.replace(/^\/Users\/[^/]+/, "~"))}</span></div><button class="btn" data-fo="open">Open</button><button class="btn" data-fo="finder">Show in Finder</button><button class="btn danger" id="vdel">Delete</button><button class="x" id="vclose" aria-label="Close">×</button></div><div class="vbody">${body}</div></div></div>`);
  const v = $("viewer"), close = () => { v.remove(); document.removeEventListener("keydown", esck); };
  const esck = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esck);
  v.onclick = (e) => { if (e.target === v) close(); };
  $("vclose").onclick = close;
  wireDelete(v, p, f, close);
  v.querySelectorAll("[data-fo]").forEach((x) => (x.onclick = () => api("/api/fileopen", { project: p.id, id: f.id, finder: x.dataset.fo === "finder" }).catch((e) => toast(e.message, true))));
  if (f.kind === "text") fetch(src).then((r) => r.text()).then((t) => { const el = v.querySelector(".vtext"); if (el) el.textContent = t.slice(0, 200000); });
  if ($("v3d")) import("/stl.mjs").then((m) => m.showSTL($("v3d"), src)).catch(() => { const el = $("v3d"); if (el) el.innerHTML = '<p class="hint">Couldn\'t draw this model. Open it in its app.</p>'; });
}
document.addEventListener("click", (e) => { const c = e.target.closest?.("[data-fopen]"); if (!c) return; e.preventDefault(); const [pid, id] = c.dataset.fopen.split("|"); openViewer(pid, id); });

/* ---------- Attachments: photos, documents, videos… ---------- */
const ATTACH_HEAD = "[Attached files, saved on this Mac — open and read them as needed:]"; // kept word for word: past messages are recognised by it
const kb = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const isImg = (p) => /\.(png|jpe?g|gif|webp)$/i.test(p);
function chipsHTML(sid) {
  return (S.attach[sid] || []).map((a, i) => `<span class="chip-file${a.up ? " up" : ""}${a.err ? " err" : ""}" title="${esc(a.path || a.name)}">${a.thumb ? `<img src="${a.thumb}" alt="">` : `<span class="ext">${esc((a.name.match(/\.([^.]+)$/) || ["", "file"])[1].slice(0, 4))}</span>`}<span class="fn">${esc(a.name)}</span><span class="fs">${a.up ? "uploading…" : a.err ? esc(a.err) : kb(a.size)}</span><button type="button" data-unattach="${esc(sid)}|${i}" aria-label="Remove ${esc(a.name)}">×</button></span>`).join("");
}
function paintChips(sid) { const el = document.querySelector(`[data-chips="${CSS.escape(sid)}"]`); if (el) { el.innerHTML = chipsHTML(sid); wireChips(el); } const f = document.querySelector(`[data-send="${CSS.escape(sid)}"]`); if (f) f.querySelector('button[aria-label="Send"]').disabled = !f.querySelector("textarea").value.trim() && !(S.attach[sid] || []).some((a) => a.path); }
function wireChips(root) { root.querySelectorAll("[data-unattach]").forEach((b) => (b.onclick = () => { const [sid, i] = b.dataset.unattach.split("|"); S.attach[sid].splice(+i, 1); paintChips(sid); })); }
async function attachFiles(pid, sid, files) {
  for (const f of files) {
    const a = { name: f.name || `pasted-${Date.now()}.png`, size: f.size, up: true, thumb: f.type.startsWith("image/") ? URL.createObjectURL(f) : "" };
    (S.attach[sid] ||= []).push(a); paintChips(sid);
    try {
      const r = await fetch(`/api/upload?project=${encodeURIComponent(pid)}&session=${encodeURIComponent(sid)}&name=${encodeURIComponent(a.name)}`, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Upload failed");
      Object.assign(a, { up: false, path: j.path, type: f.type });
    } catch (e) { Object.assign(a, { up: false, err: e.message }); }
    paintChips(sid);
  }
}
// What she sees of her own message: the text, then the attachments as thumbnails or file chips.
function meText(t) {
  const i = t.indexOf(ATTACH_HEAD);
  if (i < 0) return md(t);
  const files = t.slice(i + ATTACH_HEAD.length).split("\n").map((l) => l.match(/^- ((?:\/|[A-Za-z]:\\)\S.*?)(?:\s+\(.*\))?$/)?.[1]).filter(Boolean);
  return md(t.slice(0, i).trim()) + `<span class="att">${files.map((p) => isImg(p) ? `<a href="/api/file?path=${encodeURIComponent(p)}" target="_blank" rel="noopener"><img src="/api/file?path=${encodeURIComponent(p)}" alt="" loading="lazy"></a>` : `<span class="chip-file sent"><span class="ext">${esc((p.match(/\.([^.]+)$/) || ["", "file"])[1].slice(0, 4))}</span><span class="fn">${esc(p.split("/").pop().replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}_/, ""))}</span></span>`).join("")}</span>`;
}

function markSeen({ p, s }) {
  if (s.state !== "waiting" || !document.hasFocus() || S.seen[s.id] === s.lastAt) return;
  S.seen[s.id] = s.lastAt;
  op("session.set", p.id, { id: s.id, seenAt: new Date().toISOString() }).catch(() => {});
}
window.addEventListener("focus", () => { if (S.tab === "chats") for (const id of S.panes[paneKey()] || []) { const x = findS(id); if (x) markSeen(x); } });

function wireChats(p, key) {
  const b = $("body");
  $("togglelist").onclick = () => { S.listOpen = !S.listOpen; render(); };
  $("newsess").onclick = () => { S.sheet = !S.sheet; render(); $("ns-name")?.focus(); };
  b.querySelectorAll("[data-s]").forEach((x) => (x.onclick = () => { openPane(key, x.dataset.s); $("say-" + x.dataset.s)?.focus(); }));
  b.querySelectorAll("[data-close]").forEach((x) => (x.onclick = () => { S.panes[key] = S.panes[key].filter((id) => id !== x.dataset.close); render(); }));
  b.querySelectorAll("[data-pane]").forEach((x) => (x.onfocusin = () => { if (S.focus[key] !== x.dataset.pane) { S.focus[key] = x.dataset.pane; b.querySelectorAll(".pane-c").forEach((y) => y.classList.toggle("focus", y === x && S.panes[key].length > 1)); } }));
  wireHelpers(b);
  b.querySelectorAll("[data-runit]").forEach((x) => (x.onclick = () => { const [sid, i] = x.dataset.runit.split("|"); const d = findS(sid)?.s.denied?.[+i]; const ta = $("say-" + sid); if (d && ta) { ta.value = "! " + d.command; ta.dispatchEvent(new Event("input")); ta.focus(); } }));
  b.querySelectorAll("[data-qopt]").forEach((x) => (x.onclick = () => pickAnswer(x.dataset.qopt)));
  b.querySelectorAll("[data-qsend]").forEach((x) => (x.onclick = () => { const [pid, sid] = x.dataset.qsend.split("|"); sendAnswers(pid, sid); }));
  b.querySelectorAll("[data-ask]").forEach((x) => (x.onclick = () => { const [pid, sid, id, answer] = x.dataset.ask.split("|"); answerAsk(pid, sid, id, answer); }));
  b.querySelectorAll("[data-undeny]").forEach((x) => (x.onclick = async () => { const [pid, sid, i] = x.dataset.undeny.split("|"); const s = findS(sid)?.s; if (!s) return; await op("session.set", pid, { id: sid, denied: (s.denied || []).filter((_, k) => k !== +i) }).catch(() => {}); refresh(); }));
  b.querySelectorAll("[data-stop]").forEach((x) => (x.onclick = () => api("/api/stop", { session: x.dataset.stop }).catch((e) => toast(e.message, true))));
  const sh = $("sheet");
  if (sh) {
    const pick = $("ns-track"); pick.onchange = () => { $("ns-dir").value = P().find((x) => x.id === pick.value.split("|")[0]).folder; };
    $("ns-cancel").onclick = () => { S.sheet = false; render(); };
    sh.onsubmit = async (e) => {
      e.preventDefault(); const [pid, track] = pick.value.split("|");
      try {
        const s = await api("/api/session", { project: pid, track, name: $("ns-name").value.trim() || "New session", cwd: $("ns-dir").value.trim() });
        S.sheet = false; await refresh(); openPane(key, s.id); $("say-" + s.id)?.focus();
      } catch (err) { toast(err.message, true); }
    };
  }
  b.querySelectorAll("[data-rn]").forEach((nm) => {
    nm.onchange = async () => { if (nm.value.trim()) { await op("session.set", nm.dataset.p, { id: nm.dataset.rn, name: nm.value.trim() }).catch(() => {}); refresh(); } };
    nm.onkeydown = (e) => { if (e.key === "Enter") nm.blur(); };
  });
  wireChips(b);
  b.querySelectorAll("[data-mic]").forEach((m) => wireMic(m, $("say-" + m.dataset.mic)));
  b.querySelectorAll("[data-clip]").forEach((c) => { const inp = c.parentElement.querySelector("[data-file]"); c.onclick = () => inp.click(); inp.onchange = () => { attachFiles(c.closest("form").dataset.p, c.dataset.clip, [...inp.files]); inp.value = ""; }; });
  b.querySelectorAll("[data-pane]").forEach((pane) => {
    const sid = pane.dataset.pane, pid = pane.querySelector("[data-send]")?.dataset.p;
    pane.ondragover = (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); pane.classList.add("dropping"); } };
    pane.ondragleave = (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove("dropping"); };
    pane.ondrop = (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); pane.classList.remove("dropping"); attachFiles(pid, sid, [...e.dataTransfer.files]); };
  });
  b.querySelectorAll("[data-send]").forEach((form) => {
    if (form._wired) return; form._wired = true;   // kept across a redraw: already wired, with its draft
    const sid = form.dataset.send, ta = form.querySelector("textarea"), btn = form.querySelector('button[aria-label="Send"]');
    ta.onpaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); attachFiles(form.dataset.p, sid, fs); } };
    try { const d = sessionStorage.getItem("draft-" + sid); if (d) { ta.value = d; btn.disabled = false; } } catch {}
    // The box sizes itself (field-sizing in the CSS); measuring it by hand on every key made the whole
    // chat lay itself out again, so letters showed up late in long chats (3 Nov 2026).
    const grow = FIELD_SIZING ? () => {} : () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
    grow();
    ta.oninput = () => { btn.disabled = !ta.value.trim() && !(S.attach[sid] || []).some((a) => a.path); grow(); try { sessionStorage.setItem("draft-" + sid, ta.value); } catch {} };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault(); let v = ta.value.trim();
      const files = (S.attach[sid] || []).filter((a) => a.path);
      if ((S.attach[sid] || []).some((a) => a.up)) { toast("Still uploading — one moment."); return; }
      if (!v && !files.length) return;
      if (v.startsWith("!") && !files.length) { // like ! in Claude Code: run it in a real terminal, output goes with the next message
        try { await api("/api/shell", { project: form.dataset.p, session: sid, cmd: v.slice(1) }); ta.value = ""; try { sessionStorage.removeItem("draft-" + sid); } catch {} toast("Opened in Terminal. Its output lands here when it finishes."); refresh(); }
        catch (err) { toast(err.message, true); }
        return;
      }
      if (files.length) { v = (v || "Here are some files.") + "\n\n" + ATTACH_HEAD + "\n" + files.map((a) => `- ${a.path}  (${a.type || "file"}, ${kb(a.size)})`).join("\n"); S.attach[sid] = []; paintChips(sid); }
      const list = S.msgs[sid]?.list || []; list.push({ who: "me", text: v, at: new Date().toISOString() });
      S.msgs[sid] = { ...(S.msgs[sid] || {}), list };
      ta.value = ""; try { sessionStorage.removeItem("draft-" + sid); } catch {}
      render();
      try { await api("/api/send", { project: form.dataset.p, session: sid, text: v }); }
      catch (err) { toast(err.message, true); ta.value = v; }
    };
  });
}

// Moving around without the mouse (and from the STEER gadget, whose script presses these):
// ⌃⌥↑/↓ previous/next project in sidebar order, ⌃⌥←/→ previous/next track ("All tracks" included).
// They wrap at the ends and work while typing; a toast says where you landed.
const NAV = { ArrowUp: ["p", -1], ArrowDown: ["p", 1], ArrowLeft: ["t", -1], ArrowRight: ["t", 1] };
document.addEventListener("keydown", (e) => {
  const n = NAV[e.key]; if (!n || !e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || !P().length) return;
  e.preventDefault();
  const [what, d] = n, wrap = (i, len) => (i + len) % len;
  if (what === "p") {
    const R = railOrder(), i = R.findIndex((p) => p.id === S.view);
    S.view = R[i < 0 ? (d > 0 ? 0 : R.length - 1) : wrap(i + d, R.length)].id; S.track = "all"; S.sheet = false; S.filter = "all"; S.msForm = null;
    if (proj()?.kind === "sales") S.tab = "leads"; else if (["leads", "outreach"].includes(S.tab)) S.tab = "chats";
  } else {
    const p = proj(); if (!p) return;
    const ids = ["all", ...p.tracks.map((t) => t.id)], i = Math.max(0, ids.indexOf(S.track));
    S.track = ids[wrap(i + d, ids.length)]; S.msForm = null;
  }
  render();
  const p = proj(); if (p) toast(`${p.name} · ${S.track === "all" ? "All tracks" : trName(p, S.track)}`);
});

// The STEER gadget drives the Desk (Diogo, 1 Nov 2026). Its relay on this Mac (127.0.0.1:7899, run by
// the 3D project's session) streams what the pad feels. Sliding steps through projects (up/down) or the
// tabs Chats … Files (left/right) one notch at a time as the thumb moves, a flick glides on and slows
// down, and each notch that really moved gives a tiny buzz (her pick "A": Apple TV remote / iPod wheel
// feel; no wrap-around, so the ends feel like a wall). A slide that starts on the pad's right-hand
// column scrolls the open chat instead (smoothly, a flick glides on, a light tick every ~150 px; on the
// other tabs it scrolls the page). Hold the thumb still = dictate into the open chat's box live;
// while still holding, slide right = send it now, slide left = keep deleting words until the thumb
// lifts; just lifting = stop listening, the text stays (her design, 1 Nov: taps no longer send —
// a tap / double tap mix was too easy to get wrong with live sessions on the other end). Only the Desk window last focused acts, and only while it is
// on screen. If the relay is not running nothing happens.
const STEER = "http://127.0.0.1:7899", STEER_ME = Math.random().toString(36).slice(2);
// Which window the STEER drives is decided by the Desk server, not this browser: two Desk windows in
// different browsers (the Dock app and a Chrome tab) don't share storage, so both used to act on the
// same dictation and send it to two chats at once (2 Nov 2026). The window last focused claims it.
let steerOwner = null;
const claimSteer = () => fetch("/api/steer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: STEER_ME }) }).then((r) => r.json()).then((j) => { steerOwner = j.owner; }).catch(() => {});
const steerMine = () => !document.hidden && steerOwner === STEER_ME;
window.addEventListener("focus", claimSteer);
if (document.hasFocus()) claimSteer();
const steerBox = () => { const key = paneKey(), sid = S.focus[key] || (S.panes[key] || [])[0]; return sid ? $("say-" + sid) : null; };
let steerBase = null;
function steerNav(axis, d) {
  let moved = false;
  if (axis === "y") {
    const ids = railOrder().map((p) => p.id), i = ids.indexOf(S.view), j = i < 0 ? (d > 0 ? 0 : -1) : i + d;
    if (j >= 0 && j < ids.length) { S.view = ids[j]; S.track = "all"; S.sheet = false; S.filter = "all"; S.msForm = null; moved = true; if (proj()?.kind === "sales") S.tab = "leads"; else if (["leads", "outreach"].includes(S.tab)) S.tab = "chats"; }
  } else {
    const T = (proj()?.kind === "sales" ? SALES_TABS : PTABS).map((x) => x[0]), i = Math.max(0, T.indexOf(S.tab)), j = i + d;
    if (j >= 0 && j < T.length) { S.tab = T[j]; S.msForm = null; moved = true; }
  }
  if (!moved) return;
  save(); render(); fetch(STEER + "/buzz", { method: "POST", body: "18" }).catch(() => {});   // the notch
  const p = proj();
  toast(axis === "y" ? (p ? p.name : "All projects") : ([...PTABS, ...SALES_TABS].find((x) => x[0] === S.tab) || [, S.tab])[1]);
}
// scrolling: the relay sends thumb travel in pad squares; it is eased in over a few frames so 37 updates
// a second read as one smooth movement
let steerTarget = 0, steerTick = 0, steerRaf = 0;
const steerScroller = () => S.tab === "chats" ? document.querySelector(`.msgs[data-for="${CSS.escape(S.focus[paneKey()] || (S.panes[paneKey()] || [])[0] || "")}"]`) : $("body");
function steerScroll(dy) {
  steerTarget += dy * 260;                                   // px per square of thumb travel
  if (steerRaf) return;
  const tickFrame = () => {
    const el = steerScroller(); if (!el) { steerTarget = 0; steerRaf = 0; return; }
    const step = Math.abs(steerTarget) < 1 ? steerTarget : steerTarget * 0.35, before = el.scrollTop;
    el.scrollTop += step; steerTarget -= step;
    steerTick += Math.abs(el.scrollTop - before);
    if (steerTick >= 150) { steerTick = 0; fetch(STEER + "/buzz", { method: "POST", body: "12" }).catch(() => {}); }
    if (el.scrollTop === before && Math.abs(step) >= 1) steerTarget = 0;   // at the top or bottom: stop
    steerRaf = Math.abs(steerTarget) >= 0.5 ? requestAnimationFrame(tickFrame) : 0;
  };
  steerRaf = requestAnimationFrame(tickFrame);
}
let steerSendNext = false, steerDelT = 0;
const steerBuzz = (ms) => fetch(STEER + "/buzz", { method: "POST", body: String(ms) }).catch(() => {});
function steerSend() {
  const ta = steerBox(); if (S.tab !== "chats" || !ta) return;
  if (ta.value.trim()) { ta.closest("form").requestSubmit(); toast("Sent."); } else toast("Nothing to send.");
}
function steerEdit(action) {
  if (action === "send") {
    if (steerBase !== null) steerSendNext = true;            // still writing down the last words: send when they land
    else steerSend();
  } else if (action === "delete-start") {
    steerBase = null; steerSendNext = false;                  // words still in flight are dropped
    clearTimeout(steerDelT); const t0 = Date.now();
    const del = () => {
      const ta = steerBox(); if (!ta || !ta.value) { steerDelT = 0; return; }
      ta.value = ta.value.replace(/\s*\S+\s*$/, ""); ta.dispatchEvent(new Event("input")); steerBuzz(8);   // one word, one tick
      steerDelT = setTimeout(del, Date.now() - t0 > 1200 ? 70 : 160);                                       // speeds up after a second
    };
    del();
  } else if (action === "delete-stop") { clearTimeout(steerDelT); steerDelT = 0; }
}
function steerGesture() {}                                   // taps do nothing on the Desk (see above)
function steerDict(j) {
  if (j.state === "start") {
    if (S.tab !== "chats") { S.tab = "chats"; save(); render(); }
    const ta = steerBox(); if (!ta) { toast("Open a chat first."); return; }
    steerBase = ta.value.trim() ? ta.value.replace(/\s*$/, " ") : ""; ta.focus(); toast("Listening…");
    return;
  }
  if (steerBase === null) return;
  const ta = steerBox(); if (!ta) return;
  ta.value = steerBase + (j.text || ""); ta.dispatchEvent(new Event("input"));   // grows the box, enables Send, keeps the draft
  if (j.state === "end") {
    steerBase = null;
    if (steerSendNext) { steerSendNext = false; steerSend(); }
    else toast(j.text ? "Got it. Hold and slide right to send." : "Didn't catch anything.");
  }
}
(function steer() {
  const es = new EventSource(STEER + "/events?lite");
  es.onmessage = (e) => {
    let j; try { j = JSON.parse(e.data); } catch { return; }
    if (!steerMine()) return;
    if (j.k === "nav") steerNav(j.axis, j.d);
    else if (j.k === "scroll") steerScroll(j.dy);
    else if (j.k === "edit") steerEdit(j.action);
    else if (j.k === "gesture") steerGesture(j.ev);
    else if (j.k === "dict") steerDict(j);
  };
  setInterval(() => { if (steerMine()) fetch(STEER + "/claim", { method: "POST" }).catch(() => {}); }, 1500);   // keeps the STEER's Bluetooth mouse off
})();

// The Desk as an app in the Dock (Safari: File › Add to Dock). The service worker only makes it
// installable; it caches nothing, so the page is always the live Desk.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

refresh();
connect();


/* ---------- Voice: hold the mic, speak, let go — the words land in the message box ---------- */
// Recorded here, turned into text on this computer (the server's local whisper), never sent anywhere.
function wireMic(btn, ta) {
  if (!btn || !ta || btn._wired) return;   // a chat kept across a redraw is already wired (and may be recording)
  btn._wired = true;
  let rec = null, chunks = [], stream = null;
  const stop = () => { if (rec && rec.state === "recording") rec.stop(); };
  btn.onpointerdown = async (e) => {
    e.preventDefault();
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return toast("The Desk can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone.", true); }
    chunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = (x) => x.data.size && chunks.push(x.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); btn.classList.remove("on"); btn.classList.add("busy");
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 2000) { btn.classList.remove("busy"); return; }
      try {
        const r = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const j = await r.json(); if (!r.ok) throw new Error(j.error);
        if (j.text) { ta.value = (ta.value.trim() ? ta.value.trimEnd() + " " : "") + j.text; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); }
      } catch (err) { toast(err.message || "Couldn't turn that into text.", true); }
      btn.classList.remove("busy");
    };
    rec.start(); btn.classList.add("on");
  };
  btn.onpointerup = stop; btn.onpointerleave = stop; btn.onpointercancel = stop;
}


/* Numbers: each figure is a small chart of its history (desk metric keeps up to 60 points, set only by Claude Code:
   Diogo, 3 Nov 2026, "only Claude Code should manage that, not humans"). Green when it moves the good way (better: up
   by default, "down" for figures where lower is good), red when the bad way; a dashed line for the target. */
const nnum = (v) => { const x = parseFloat(String(v).replace(/[^0-9.,-]/g, "").replace(",", ".")); return isFinite(x) ? x : null; };
const npts = (m) => (m.history || []).map((h) => ({ at: h.at, v: nnum(h.value) })).filter((p) => p.v !== null);
const nday = (at) => { const d = new Date(at); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const nfmt = (x) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-GB") : String(Math.round(x * 10) / 10));
function ndelta(m, p) {
  if (p.length < 2) return "";
  const a = p[p.length - 2].v, b = p[p.length - 1].v, d = b - a;
  if (!d) return `<span class="ndelta">no change</span>`;
  const good = (d > 0) === (m.better !== "down"), pct = a ? Math.round((d / Math.abs(a)) * 100) : null;
  return `<span class="ndelta ${good ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${pct !== null ? Math.abs(pct) + "%" : nfmt(Math.abs(d))} <span class="nvs">vs ${esc(nday(p[p.length - 2].at))}</span></span>`;
}
function nchart(m, p) {
  if (p.length < 2) return `<div class="nnochart">The line starts with the next figure.</div>`;
  const W = 300, H = 92, L = 4, R = 4, T = 8, B = 8, t = nnum(m.target);
  const vals = p.map((x) => x.v).concat(t !== null ? [t] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i) => L + (i / (p.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = p.map((q, i) => `${x(i).toFixed(1)},${y(q.v).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${H - B} ${line} ${x(p.length - 1).toFixed(1)},${H - B}`;
  const d = p[p.length - 1].v - p[0].v, cls = !d ? "flat" : (d > 0) === (m.better !== "down") ? "good" : "bad";
  const last = p[p.length - 1], mn = Math.min(...p.map((q) => q.v)), mx = Math.max(...p.map((q) => q.v));
  return `<svg class="nchart ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(m.label)} over time">
    ${t !== null ? `<line class="ntarget" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` : ""}
    <polygon class="narea" points="${area}"/><polyline class="nline" points="${line}"/>
    <circle class="ndot" cx="${x(p.length - 1).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3"/></svg>
  <div class="naxis"><span>${esc(nday(p[0].at))}</span><span>low ${esc(nfmt(mn))} · high ${esc(nfmt(mx))}${t !== null ? ` · target ${esc(m.target)}` : ""}</span><span>${esc(nday(last.at))}</span></div>`;
}
function ncard(m) {
  const p = npts(m), v = m.view && (proj().files || []).find((f) => f.id === m.view && f.path);
  if (v) return `<div class="card ncard nwide"><div class="nl">${esc(m.label)}</div><div class="nhead"><span class="nv">${esc(m.value)}</span>${ndelta(m, p)}</div>`
    + `<iframe class="nview" src="${fsrc(proj(), v)}" title="${esc(v.title || m.label)}" loading="lazy"></iframe>${m.note ? `<div class="meta nnote">${esc(m.note)}</div>` : ""}</div>`;
  return `<div class="card ncard"><div class="nl">${esc(m.label)}</div><div class="nhead"><span class="nv">${esc(m.value)}</span>${ndelta(m, p)}</div>${nchart(m, p)}${m.note ? `<div class="meta nnote">${esc(m.note)}</div>` : ""}</div>`;
}
/* ---------- Numbers: a project's or client's figures, kept by its sessions (desk metric) ---------- */

function renderNumbers() {
  const p = proj(), b = $("body"), ms = p.metrics || [];
  if (!ms.length) { b.innerHTML = `<div class="empty">No numbers yet. Ask in any chat, e.g. "track our monthly reach on the Numbers tab": Claude keeps them current from then on.</div>`; return; }
  const groups = []; for (const m of ms) { const g = m.group || ""; let x = groups.find((y) => y.g === g); if (!x) groups.push((x = { g, ms: [] })); x.ms.push(m); }
  b.innerHTML = groups.map((x) => `${x.g ? `<h3 class="ngroup">${esc(x.g)}</h3>` : ""}<div class="ngrid">${x.ms.map(ncard).join("")}</div>`).join("");
}

/* ---------- Sales: the leads, the outreach and their numbers (shared with the partner) ---------- */
S.leadsData = null; S.lead = null; S.leadFilter = "all"; S.laneOpen = {};
async function loadLeads() { try { S.leadsData = await api("/api/leads"); } catch (e) { toast(e.message, true); } if (proj()?.kind === "sales" && ["leads", "outreach", "numbers"].includes(S.tab)) render(); }
const LANE = { new: "todo", audit: "doing", contacted: "waiting", booked: "ongoing", held: "ongoing", proposal: "sent", trial: "sent", negotiation: "sent", won: "done", lost: "blocked" };
const replied = (l) => (l.thread || []).some((m) => m.dir === "in") || (l.timeline || []).some((t) => /\bthey replied\b|^replied\b/i.test(t.text || "") && !/haven.t|if no|no reply/i.test(t.text || ""));
const srcPill = (l, d) => { const k = l.source?.kind || "manual", name = d.sources[k] || k; return `<span class="pill ${k === "outbound" ? "src-ob" : k === "form" || k === "booking" ? "src-in" : ""}">${esc(name)}${l.source?.trade ? " · " + esc(l.source.trade) : ""}</span>`; };
function needLeads() { if (!S.leadsData) { $("body").innerHTML = '<p class="hint">Loading the leads…</p>'; loadLeads(); return true; } return false; }

function renderLeads() {
  if (needLeads()) return;
  const d = S.leadsData, b = $("body");
  const F = { all: ["Everything", () => true], mine: ["Mine", (l) => (l.owner || "") === ME], outbound: ["Outreach", (l) => l.source?.kind === "outbound"], form: ["Website forms", (l) => l.source?.kind === "form"], booking: ["Booking page", (l) => l.source?.kind === "booking"], hand: ["Referral / added by hand", (l) => ["manual", "referral"].includes(l.source?.kind)] };
  const ls = d.leads.filter(F[S.leadFilter]?.[1] || (() => true));
  let h = `<div class="tools"><div class="filters">${Object.entries(F).map(([k, [n]]) => `<button class="chip" data-lf="${k}" aria-pressed="${S.leadFilter === k}">${n}</button>`).join("")}</div><button class="chip add" id="addlead">${I.plus}Lead</button></div>`;
  const lanes = d.stages.filter(([k]) => k !== "notlead");
  h += `<div class="lsplit${S.lead ? " open" : ""}"><div class="lscroll"><div class="cols leads" style="grid-template-columns:repeat(${lanes.length},minmax(180px,1fr))">`;
  for (const [k, name] of lanes) {
    const here = ls.filter((l) => l.stage === k), show = S.laneOpen[k] ? here : here.slice(0, 12);
    h += `<div class="col ${LANE[k] || "todo"}"><h3>${esc(name)} <span class="lcount">${here.length}</span></h3><div class="drop" data-stage="${k}">`;
    for (const l of show) h += `<div class="card${S.lead === l.id ? " picked" : ""}" draggable="true" tabindex="0" data-lead="${esc(l.id)}"><div class="tt">${esc(l.company || l.name || l.email)}</div><div class="meta">${srcPill(l, d)}${replied(l) ? '<span class="pill p1">Replied</span>' : ""}${l.auditReads ? '<span class="pill">Audit read</span>' : ""}${l.next?.due ? `<span class="pill${l.next.due < iso(TODAY()) ? " late" : ""}">Next ${esc(l.next.due.slice(5).split("-").reverse().join("/"))}</span>` : ""}<span>${esc(l.owner || "")}</span></div></div>`;
    if (here.length > show.length) h += `<button class="linkbtn lmore" data-lmore="${k}">+${here.length - show.length} more</button>`;
    h += `</div></div>`;
  }
  const nl = ls.filter((l) => l.stage === "notlead").length;
  h += `</div>${nl ? `<div class="hint lnote">Not a lead: ${nl} (selling to us, spam, job applications) · kept, in no count</div>` : ""}</div>`;
  if (S.lead) h += leadDetail(d.leads.find((l) => l.id === S.lead), d);
  h += `</div>`;
  b.innerHTML = h;
  b.querySelectorAll("[data-lf]").forEach((x) => (x.onclick = () => { S.leadFilter = x.dataset.lf; render(); }));
  b.querySelectorAll("[data-lmore]").forEach((x) => (x.onclick = () => { S.laneOpen[x.dataset.lmore] = true; render(); }));
  b.querySelectorAll("[data-lead]").forEach((c) => { c.onclick = () => { S.lead = S.lead === c.dataset.lead ? null : c.dataset.lead; render(); }; c.ondragstart = (e) => e.dataTransfer.setData("text/lead", c.dataset.lead); });
  b.querySelectorAll("[data-stage]").forEach((z) => { z.ondragover = (e) => { e.preventDefault(); z.classList.add("over"); }; z.ondragleave = () => z.classList.remove("over"); z.ondrop = (e) => { e.preventDefault(); z.classList.remove("over"); const id = e.dataTransfer.getData("text/lead"); if (!id) return; if (z.dataset.stage === "lost") { S.lead = id; S.askLost = true; render(); return; } leadSet(id, { stage: z.dataset.stage }); }; });
  $("addlead").onclick = addLead;
  wireLeadDetail();
}
async function leadSet(id, f) { try { await api("/api/lead", { op: "set", id, ...f }); await loadLeads(); } catch (e) { toast(e.message, true); } }

// The email exchange with a lead, oldest first, the newest open: what outreach sent (l.emails), their
// replies and our answers from the inboxes (l.thread, saved by the outreach bridge). Diogo, 5 Nov 2026:
// "I need it clear on the lead panel".
function leadThread(l) {
  const norm = (x) => String(x || "").toLowerCase().replace(/^(re|fw|fwd|enc|res):\s*/g, "").trim();
  const ours = (l.emails || []).filter((m) => m.state === "sent").map((m) => ({ at: m.at, dir: "out", subject: m.subject, text: m.text, by: "Outreach" }));
  const th = (l.thread || []).map((m) => ({ ...m, by: m.dir === "out" ? (m.account || "").split("@")[0] : "" }));
  // An outreach email also sits in the inbox's Sent: show it once.
  const all = [...ours, ...th.filter((m) => !(m.dir === "out" && ours.some((o) => norm(o.subject) === norm(m.subject) && Math.abs(Date.parse(o.at) - Date.parse(m.at)) < 2 * 864e5)))].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!all.length) return `<div class="lthread none">No emails with them yet.</div>`;
  const ins = all.filter((m) => m.dir === "in"), last = ins[ins.length - 1];
  const head = ins.length ? `<b class="lrep">They replied ${ins.length === 1 ? "once" : ins.length + " times"}</b> · last ${esc(clock(last.at))}` : `<b>No reply yet</b>`;
  return `<div class="lthread"><div class="lth">${head} · ${all.length} email${all.length === 1 ? "" : "s"}</div>${all.map((m, i) => `<details class="lmsg ${m.dir}"${i === all.length - 1 || (m.dir === "in" && m === last) ? " open" : ""}><summary><span class="lwho">${m.dir === "in" ? "They wrote" : "We sent" + (m.by ? ` · ${esc(m.by)}` : "")}</span><span class="lsub">${esc(m.subject || "(no subject)")}</span><span class="lwhen">${esc(clock(m.at))}</span></summary><div class="lbody">${esc(m.text || "(no text)")}</div></details>`).join("")}</div>`;
}
function leadDetail(l, d) {
  if (!l) return "";
  const SV = d.services, has = (k) => (l.services || []).includes(k);
  const found = l.source?.kind === "outbound" ? `Found by outreach${l.source.trade ? " · " + l.source.trade : ""}` : l.source?.kind === "form" ? `Website form${l.source.campaign ? " · " + l.source.campaign : ""}${l.source.keyword ? " · «" + l.source.keyword + "»" : ""}` : d.sources[l.source?.kind] || "Added by hand";
  const people = [...new Set([ME, ME === "Diogo" ? "João" : "Diogo", l.owner].filter(Boolean))];
  let h = `<aside class="mbox ldetail"><div class="ldh"><div class="mt">${esc(l.company || l.name)}</div><button class="x" id="lclose" aria-label="Close">×</button></div>
  <div class="meta">${srcPill(l, d)}${replied(l) ? '<span class="pill p1">Replied</span>' : ""}${l.optedOut ? '<span class="pill blk">Opted out</span>' : ""}</div>
  <div class="lkv">${l.name && l.company ? `<span>Person</span><b>${esc(l.name)}</b>` : ""}${l.email ? `<span>Email</span><b><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></b>` : ""}${l.phone ? `<span>Phone</span><b>${esc(l.phone)}</b>` : ""}${l.website ? `<span>Site</span><b><a href="${esc(/^https?:/.test(l.website) ? l.website : "https://" + l.website)}" target="_blank" rel="noopener">${esc(l.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></b>` : ""}<span>Found</span><b>${esc(found)}${l.created ? " · " + esc(clock(l.created)) : ""}</b>
  <span>Owner</span><b><select class="lsel" id="lowner">${people.map((n) => `<option${n === l.owner ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></b>
  <span>Stage</span><b><select class="lsel" id="lstage">${d.stages.map(([k, n]) => `<option value="${k}"${k === l.stage ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></b></div>
  ${S.askLost || l.stage === "lost" ? `<div class="lask"><span>Why lost?</span>${d.lost.map((r) => `<button class="chip" data-lost="${esc(r)}" aria-pressed="${l.lost?.reason === r}">${esc(r)}</button>`).join("")}</div>` : ""}
  <div class="lsv"><span>Wants</span>${Object.entries(SV).map(([k, n]) => `<button class="chip" data-sv="${k}" aria-pressed="${has(k)}">${esc(n)}</button>`).join("")}</div>
  <form class="lnext" id="lnext"><input id="lnext-t" placeholder="Next step" value="${esc(l.next?.text || "")}" maxlength="200"><input type="date" id="lnext-d" value="${esc(l.next?.due || "")}"><button class="btn">Save</button></form>`;
  for (const [i, a] of (l.audits || []).entries()) h += `<a class="lfile" href="/api/leadfile?id=${encodeURIComponent(l.id)}&n=${i}" target="_blank" rel="noopener">📄 ${esc(a.name)}${i === (l.audits.length - 1) && l.auditReads ? `<span>read ${l.auditReads}×</span>` : ""}</a>`;
  h += leadThread(l);
  h += `<ul class="mlist ltl">${(l.timeline || []).slice(-14).reverse().map((t) => `<li class="${t.kind === "next" ? "doing" : "hist"}"><span class="s"></span><span><span class="lwhen">${esc(clock(t.at))}</span> ${esc(t.text)}</span></li>`).join("")}</ul>
  <form class="lnote" id="lnoteform"><input id="lnote-t" placeholder="Add a note (a call, what they said…)" maxlength="600"><button class="btn">Add</button></form></aside>`;
  return h;
}
function wireLeadDetail() {
  const l = S.leadsData?.leads.find((x) => x.id === S.lead); if (!l) return;
  $("lclose").onclick = () => { S.lead = null; S.askLost = false; render(); };
  $("lowner").onchange = (e) => leadSet(l.id, { owner: e.target.value });
  $("lstage").onchange = (e) => { if (e.target.value === "lost") { S.askLost = true; render(); } else { S.askLost = false; leadSet(l.id, { stage: e.target.value }); } };
  document.querySelectorAll("[data-lost]").forEach((x) => (x.onclick = () => { S.askLost = false; leadSet(l.id, { stage: "lost", reason: x.dataset.lost }); }));
  document.querySelectorAll("[data-sv]").forEach((x) => (x.onclick = () => { const k = x.dataset.sv, sv = new Set(l.services || []); sv.has(k) ? sv.delete(k) : sv.add(k); leadSet(l.id, { services: [...sv] }); }));
  $("lnext").onsubmit = (e) => { e.preventDefault(); leadSet(l.id, { next: $("lnext-t").value.trim(), due: $("lnext-d").value }); };
  $("lnoteform").onsubmit = (e) => { e.preventDefault(); const t = $("lnote-t").value.trim(); if (t) leadSet(l.id, { note: t }); };
}
function addLead() {
  document.body.insertAdjacentHTML("beforeend", `<div class="viewer" id="viewer" role="dialog" aria-label="New lead"><form class="vbox glass small npform" id="lform">
    <div class="vhead"><div class="vt"><b>New lead</b><span>A referral, a call, LinkedIn, an event. Shared with ${ME === "Diogo" ? "João" : "Diogo"}.</span></div><button type="button" class="x" id="vclose" aria-label="Close">×</button></div>
    <div class="npbody"><label>Company<input id="lf-c" required maxlength="80"></label><label>Person<input id="lf-n" maxlength="80"></label><label>Email<input id="lf-e" type="email" maxlength="120"></label><label>Phone<input id="lf-p" maxlength="40"></label><label>Website<input id="lf-w" maxlength="120"></label>
    <label>Where from<select id="lf-s"><option value="referral">Referral</option><option value="manual">Call, LinkedIn, event…</option></select></label><label>Note<input id="lf-x" maxlength="300"></label></div>
    <div class="npfoot"><button type="button" class="btn" id="np-cancel">Cancel</button><button class="btn primary">Add lead</button></div></form></div>`);
  const v = $("viewer"), close = () => v.remove();
  $("vclose").onclick = close; $("np-cancel").onclick = close; v.onclick = (e) => { if (e.target === v) close(); };
  $("lf-c").focus();
  $("lform").onsubmit = async (e) => { e.preventDefault(); try { const l = await api("/api/lead", { op: "add", company: $("lf-c").value, name: $("lf-n").value, email: $("lf-e").value, phone: $("lf-p").value, website: $("lf-w").value, source: $("lf-s").value, note: $("lf-x").value }); close(); S.lead = l.id; await loadLeads(); } catch (err) { toast(err.message, true); } };
}

const ntile = (label, value, small) => `<div class="card ntile"><div class="nl">${esc(label)}</div><div class="nv">${esc(String(value))}</div><div class="meta"><span>${esc(small || "")}</span></div></div>`;
const ntable = (title, head, rows) => `<div class="card ntable"><div class="nl">${esc(title)}</div><table><tr>${head.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</table>${rows.length ? "" : '<p class="hint">Nothing yet.</p>'}</div>`;

function renderOutreach() {
  if (needLeads()) return;
  const d = S.leadsData, o = d.outreach || {}, ob = d.leads.filter((l) => l.source?.kind === "outbound");
  const day = 864e5, since = (n) => Object.entries(o.byDay || {}).filter(([k]) => Date.now() - Date.parse(k) < n * day).reduce((a, [, v]) => a + v, 0);
  const rep = ob.filter(replied), out = ob.filter((l) => l.optedOut);
  const next = ob.filter((l) => l.next?.due && !["won", "lost", "notlead"].includes(l.stage)).sort((a, b) => a.next.due.localeCompare(b.next.due)).slice(0, 12);
  const trades = {}; for (const l of ob) { const t = (trades[l.source?.trade || "other"] ||= [l.source?.trade || "other", 0, 0, 0]); t[1]++; if (l.stage !== "new") t[2]++; if (replied(l)) t[3]++; }
  // Kept current every 10 minutes by the outreach bridge on Diogo's Mac; a stale snapshot means it stopped.
  const stale = !o.at || Date.now() - Date.parse(o.at) > 3 * 3600e3;
  let h = stale ? `<div class="banner-note">The outreach hasn't reported since ${esc(o.at ? clock(o.at) : "—")}. It runs on Diogo's Mac (the outreach bridge): check that the Mac is on.</div>` : "";
  h += `<div class="ntiles">${ntile("Sent in the last 7 days", since(7), `${o.sent ?? 0} since ${o.firstSent ? clock(o.firstSent) : "the start"}`)}${ntile("Waiting for a yes", o.waiting ?? 0, `${o.held ?? 0} held back by the guards`)}${ntile("Replied", rep.length, rep.map((l) => l.company).slice(0, 3).join(", "))}${ntile("Opted out", out.length, "never written to again")}</div>`;
  h += `<div class="ntwo">${ntable("Next follow-ups", ["Lead", "Trade", "Next step", "When"], next.map((l) => [l.company, l.source?.trade || "", l.next.text, l.next.due.split("-").reverse().join("/")]))}${ntable("Trades so far", ["Trade", "Found", "Emailed", "Replied"], Object.values(trades).sort((a, b) => b[1] - a[1]))}</div>`;
  h += ntable("Sending inboxes", ["Inbox", "Daily limit", "Started"], (o.inboxes || []).map((i) => [i.address, i.dailyCap ? `up to ${i.dailyCap} a day` : "—", i.rampStart ? clock(i.rampStart) : "—"]));
  if ((o.rules || []).length) h += `<p class="hint">Its rules: ${o.rules.map(esc).join(" ")}</p>`;
  $("body").innerHTML = h;
}

function renderSalesNumbers() {
  if (needLeads()) return;
  const n = S.leadsData.numbers;
  let h = `<div class="ntiles">${ntile("Leads, all time", n.total, n.bySource.map((r) => `${r.leads} ${r.source.toLowerCase()}`).join(" · "))}${ntile("Calls booked", n.booked, `from ${n.total} leads`)}${ntile("Won", n.won, "")}${ntile("Ad spend · cost per lead", "—", "from Google Ads once it's connected")}</div>`;
  h += ntable("Where leads come from, and how far they get", ["Source", "Leads", "Still open", "Contacted", "Call booked", "Proposal", "Won", "Lost"], n.bySource.map((r) => [r.source, r.leads, r.open, r.contacted, r.booked, r.proposal, r.won, r.lost]));
  h += `<div class="ntwo">${ntable("What leads want", ["Service", "Leads"], Object.entries(n.services).sort((a, b) => b[1] - a[1]))}${ntable("Who has them", ["Owner", "Open", "Won"], n.owners.map((o) => [o.owner, o.open, o.won]))}</div>`;
  const p = proj(); if ((p.metrics || []).length) h += `<div class="ntiles">${p.metrics.map((m) => ntile(m.label, m.value, m.note)).join("")}</div>`;
  $("body").innerHTML = h;
}

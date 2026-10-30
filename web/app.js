// Desk — the page. Data comes from the local server (/api/state); changes go back through /api/op,
// and the server pushes "something changed" over /api/events, so sessions' edits show up live.

const I = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>',
  grid: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6.2 8.2h4M6.2 10.8h4"/></svg>',
};
const ME = "Diogo"; // the one person using the Desk
const STATUSES = [["ongoing", "Ongoing"], ["todo", "To do"], ["doing", "Doing"], ["blocked", "Blocked"], ["waiting", "Waiting on"], ["sent", "Sent"], ["done", "Done"]];
const ST_KEYS = STATUSES.map((x) => x[0]);
const EMPTY = { ongoing: "No standing duties.", todo: "Nothing to do.", doing: "Nothing in progress.", blocked: "Nothing blocked.", waiting: "Not waiting on anyone.", sent: "Nothing out for feedback.", done: "Nothing finished recently." };
const ORDER = { waiting: 0, working: 1, idle: 2 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TODAY = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmt = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T00:00:00" : s); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
const fmtShort = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const clock = (s) => { if (!s) return ""; const d = new Date(s); if (isNaN(d)) return ""; const today = iso(TODAY()) === iso(d); return today ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const daysSince = (s) => Math.floor((Date.now() - new Date(s)) / 864e5);
// An ongoing duty is due again one cycle after it was last done.
const CYCLE = { daily: 1, weekly: 7, monthly: 31 };
const ongoingLate = (t) => t.status === "ongoing" && (!t.lastDone || daysSince(t.lastDone) >= (CYCLE[t.every] || 7) + (t.every === "daily" ? 0 : 1));
const dueState = (t) => { if (!t.due || ["done", "sent", "ongoing"].includes(t.status)) return ""; const d = (new Date(t.due + "T00:00:00") - TODAY()) / 864e5; return d < 0 ? "over" : d <= 3 ? "soon" : ""; };
const needsMe = (t) => (t.status === "waiting" && t.waitingOn === ME) || (t.owner === ME && !["done", "sent"].includes(t.status));
const initials = (n) => n.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "·";

// Claude writes markdown; show it as it reads. Escaped first, so nothing in it becomes HTML.
function md(s) {
  const blocks = [];
  let h = esc(s).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => { blocks.push(c); return `\u0000${blocks.length - 1}\u0000`; });
  h = h.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[i]}</pre>`);
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
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : ""); clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), err ? 5000 : 2200); }

// ---- state ----
let D = { projects: [] };
const S = { agents: {}, agentsAt: {}, helpersOpen: {}, view: "all", track: "all", tab: "chats", filter: "all", allDone: false, panes: {}, focus: {}, listOpen: false, sheet: false, meet: {}, meetMode: "paste", msForm: null, pendingDel: null, msgs: {}, stream: {}, seen: {}, why: null };
try { const v = JSON.parse(localStorage.getItem("desk-ui") || "null"); if (v) Object.assign(S, { view: v.view || "all", track: v.track || "all", tab: v.tab || "chats", listOpen: !!v.listOpen, panes: v.panes || {} }); } catch {}
const save = () => { try { localStorage.setItem("desk-ui", JSON.stringify({ view: S.view, track: S.track, tab: S.tab, listOpen: S.listOpen, panes: S.panes })); } catch {} };

const P = () => D.projects;
const proj = () => P().find((p) => p.id === S.view);
const scopeP = () => (S.view === "all" ? P() : [proj()].filter(Boolean));
const inTrack = (x) => S.view === "all" || S.track === "all" || x.track === S.track;
const trName = (p, id) => p.tracks.find((t) => t.id === id)?.name || "";
const findS = (id) => { for (const p of P()) { const s = p.sessions.find((x) => x.id === id); if (s) return { p, s }; } return null; };
const allTodos = () => scopeP().flatMap((p) => p.todos.filter(inTrack).map((t) => ({ p, t })));
const allSessions = () => scopeP().flatMap((p) => p.sessions.filter(inTrack).map((s) => ({ p, s })));
const allMeetings = () => scopeP().flatMap((p) => p.meetings.filter(inTrack).map((m) => ({ p, m }))).sort((a, b) => b.m.date.localeCompare(a.m.date));
// The people a project's cards can wait on: only that project's own, so projects never mix.
const people = (p) => [...new Set([ME, ...(p?.todos || []).flatMap((t) => [t.waitingOn, t.sentTo, t.owner])].filter((x) => x && !["Claude", "Managers"].includes(x)))];
// A session counts as working while it replies, or while one of its helpers is still running.
const stateOf = (s) => (S.stream[s.id]?.active || (s.state === "idle" && (S.agents[s.id] || []).some((a) => a.state === "running")) ? "working" : s.state);

async function refresh() {
  try { D = await api("/api/state"); $("offline")?.remove(); }
  catch { if (!$("offline")) document.body.insertAdjacentHTML("beforeend", '<div class="offline" id="offline">The Desk server isn\'t running. Start it with: desk open</div>'); return; }
  if (S.view !== "all" && !proj()) { S.view = "all"; S.track = "all"; }
  if (proj() && S.track !== "all" && !proj().tracks.some((t) => t.id === S.track)) S.track = "all";
  render();
}
let refreshT;
const soon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 150); };

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "state") soon();
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
  if (ev.kind === "start") { st.active = true; st.text = ""; st.tool = ""; render(); }
  else if (ev.kind === "queued") { st.queued++; }
  else if (ev.kind === "message") { if (st.text && !st.text.endsWith("\n\n")) st.text += "\n\n"; }
  else if (ev.kind === "delta") { st.text += ev.text; st.tool = ""; paintLive(ev.session); }
  else if (ev.kind === "tool") { st.tool = ev.name; paintLive(ev.session); }
  else if (ev.kind === "done") {
    st.active = false; st.queued = Math.max(0, st.queued - 1);
    if (ev.error) toast(ev.error, true);
    delete S.msgs[ev.session]; st.text = ""; refresh();
  }
}
function paintLive(sid) {
  const el = document.querySelector(`[data-live="${CSS.escape(sid)}"]`);
  if (!el) return;
  const st = S.stream[sid];
  el.querySelector(".tx").innerHTML = st.text ? md(st.text) : "";
  el.querySelector(".wk").textContent = st.tool ? `Working · ${st.tool}` : "Working";
  const box = el.closest(".msgs"); if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

// ---- render (keeps focus, drafts and scroll positions across re-renders) ----
function render() {
  const a = document.activeElement, fid = a?.id, sel = fid && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
  const scroll = {};
  document.querySelectorAll(".msgs[data-for]").forEach((m) => (scroll[m.dataset.for] = m.scrollHeight - m.scrollTop - m.clientHeight < 40 ? "end" : m.scrollTop));
  const bodyScroll = $("body")?.scrollTop;
  renderRail(); renderMain(); save();
  document.querySelectorAll(".msgs[data-for]").forEach((m) => { const v = scroll[m.dataset.for]; m.scrollTop = v === undefined || v === "end" ? m.scrollHeight : v; });
  if (bodyScroll && $("body")) $("body").scrollTop = bodyScroll;
  if (fid && $(fid)) { const el = $(fid); el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch {} }
}

function renderRail() {
  const r = $("rail");
  const unread = (ss) => ss.some((s) => stateOf(s) === "waiting");
  const allS = P().flatMap((p) => p.sessions);
  let h = `<button class="ritem" aria-current="${S.view === "all"}" data-go="all" title="All projects"><span class="pav${unread(allS) ? " unread" : ""}" style="background:var(--me);color:var(--me-ink)">${I.grid}</span><span class="nm">All projects</span></button><div class="rail-label">Projects</div>`;
  for (const p of P()) {
    const cur = S.view === p.id;
    h += `<button class="ritem" aria-current="${cur}" data-go="${p.id}" title="${esc(p.name)}"><span class="pav${unread(p.sessions) ? " unread" : ""}${p.logo ? " logo" : ""}" style="background:${p.color}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : esc(p.name[0])}</span><span class="nm">${esc(p.name)}</span><span class="live">${p.sessions.map((s) => `<span class="dot ${stateOf(s)}"></span>`).join("")}</span></button>`;
    if (cur && p.tracks.length > 1) h += `<div class="subtracks">${p.tracks.map((t) => `<button data-track="${t.id}" aria-current="${S.track === t.id}"><span>${esc(t.name)}</span><span class="live">${p.sessions.filter((s) => s.track === t.id).map((s) => `<span class="dot ${stateOf(s)}"></span>`).join("")}</span></button>`).join("")}</div>`;
  }
  r.innerHTML = h;
  const all = P().flatMap((p) => p.sessions);
  $("railfoot").innerHTML = `<b>${fmt(new Date().toISOString())}</b><br>${all.filter((s) => stateOf(s) === "working").length} working · ${all.filter((s) => stateOf(s) === "waiting").length} new replies`;
  r.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { if (S.view !== b.dataset.go) { S.view = b.dataset.go; S.track = "all"; S.sheet = false; S.filter = "all"; S.msForm = null; } render(); }));
  r.querySelectorAll("[data-track]").forEach((b) => (b.onclick = () => { S.track = S.track === b.dataset.track ? "all" : b.dataset.track; S.msForm = null; render(); }));
}

function renderMain() {
  const p = proj();
  const unread = allSessions().some((x) => stateOf(x.s) === "waiting");
  let h = `<div class="top"><h1 title="${p ? esc(p.folder) : ""}">${p ? esc(p.name) : "All projects"}</h1>
    <div class="seg" role="tablist">${[["chats", "Chats"], ["roadmap", "Roadmap"], ["board", "Board"], ["meetings", "Meetings"]].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${k === "chats" && unread ? '<span class="udot" title="New replies"></span>' : ""}</button>`).join("")}</div>`;
  if (p) h += `<div class="tracks">${p.tracks.length > 1 ? `<button class="chip" data-tr="all" aria-pressed="${S.track === "all"}">All tracks</button>` : ""}${p.tracks.map((t) => trackChip(p, t)).join("")}<button class="chip add" id="addtrack">${I.plus}Track</button></div>`;
  h += `</div><div class="body${S.tab === "chats" ? " chat-body" : ""}" id="body"></div>`;
  $("main").innerHTML = h;
  $("main").querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); }));
  if (p) wireTracks(p);
  ({ chats: renderChats, roadmap: renderRoadmap, board: renderBoard, meetings: renderMeetings }[S.tab] || renderChats)();
}

function trackChip(p, t) {
  const on = p.tracks.length === 1 || S.track === t.id;
  return `<button class="chip" data-tr="${t.id}" aria-pressed="${on && p.tracks.length > 1}"><span>${esc(t.name)}</span>${on ? `<span class="edit" role="button" tabindex="0" aria-label="Rename track ${esc(t.name)}" data-rename="${t.id}">${I.pen}</span>` : ""}</button>`;
}
function wireTracks(p) {
  const m = $("main");
  m.querySelectorAll("[data-tr]").forEach((b) => (b.onclick = (e) => { if (e.target.closest("[data-rename]") || e.target.tagName === "INPUT") return; S.track = b.dataset.tr; S.msForm = null; render(); }));
  m.querySelectorAll("[data-rename]").forEach((el) => { const go = (e) => { e.stopPropagation(); startRename(p, el.dataset.rename, el.closest(".chip")); }; el.onclick = go; el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } }; });
  $("addtrack").onclick = async () => { const t = (await op("track.add", p.id, { name: "New track" })).result; await refresh(); S.track = t.id; render(); const c = document.querySelector(`.chip[data-tr="${t.id}"]`); if (c) startRename(proj(), t.id, c); };
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

function renderChats() {
  const b = $("body"), p = proj(), list = allSessions(), key = paneKey();
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
  h += `</div><div class="panewrap">`;
  if (S.sheet) {
    h += `<form class="sheet" id="sheet"><label for="ns-name">What should it work on?<input id="ns-name" placeholder="e.g. Fix the booking reminder" maxlength="40" autocomplete="off"></label>
      <label for="ns-track">${p ? "Track" : "Project · track"}<select id="ns-track">${scopeP().flatMap((pp) => pp.tracks.map((t) => `<option value="${pp.id}|${t.id}"${S.track === t.id ? " selected" : ""}>${p ? "" : esc(pp.name) + " · "}${esc(t.name)}</option>`)).join("")}</select></label>
      <label for="ns-dir">Folder<input id="ns-dir" value="${esc((p || P()[0])?.folder || "~")}"></label>
      <div class="r"><button type="button" class="btn" id="ns-cancel">Cancel</button><button class="btn primary">Start session</button></div></form>`;
  }
  if (!panes.length) h += `<div class="nochat">${list.length ? "Pick sessions from the list to open them side by side." : "No sessions here yet.<br>Start one to work on something in parallel."}</div>`;
  else h += `<div class="panes">${panes.map((id) => paneHTML(findS(id), key)).join("")}</div>`;
  b.innerHTML = h + `</div></div>`;
  wireChats(p, key);
  for (const id of panes) { const x = findS(id); if (x) { ensureMsgs(x.s, x.p); markSeen(x); loadAgents(x); } }
}
function paneHTML({ p: sp, s }, key) {
  const label = `${sp.name} · ${trName(sp, s.track)}`; // shown on hover only: the pane header is just the session's name
  const st = stateOf(s), live = S.stream[s.id], msgs = S.msgs[s.id]?.list;
  let body = msgs == null ? '<div class="m sys">Loading…</div>' : msgs.length ? msgs.map((m) => `<div class="m ${m.who}">${md(m.text)}${m.who === "claude" && m.tools ? `<span class="steps">${m.tools} step${m.tools === 1 ? "" : "s"}</span>` : ""}<span class="when">${esc(clock(m.at))}</span></div>`).join("") : `<div class="m sys">${s.started === false ? `New session in ${esc(s.cwd)}. Say what you need; it starts with your first message.` : "Nothing said yet."}</div>`;
  for (const e of s.pendingShell || []) body += `<div class="m shell"><div class="sh-h"><code>$ ${esc(e.cmd)}</code><span>${e.state === "running" ? "running in Terminal…" : `exit ${e.code ?? "?"} · goes with your next message`}</span></div>${e.state === "done" ? `<pre>${esc(e.output || "(no output)")}</pre>` : ""}</div>`;
  if (live?.active) body += `<div class="m claude live" data-live="${esc(s.id)}"><span class="tx">${live.text ? md(live.text) : ""}</span><span class="workline"><span class="typing"><i></i><i></i><i></i></span><span class="wk">${live.tool ? "Working · " + esc(live.tool) : "Working"}</span></span></div>`;
  return `<section class="pane-c${S.focus[key] === s.id && S.panes[key].length > 1 ? " focus" : ""}${st === "waiting" ? " unread" : ""}" data-pane="${s.id}">
   <div class="convhead"><div class="l"><span class="sw" style="background:${sp.color}" title="${esc(label)}"></span>
     <input class="sname" data-rn="${s.id}" data-p="${sp.id}" id="sn-${s.id}" value="${esc(s.name)}" aria-label="Session name" maxlength="40" title="${esc(s.cwd)}"></div>
     <div class="hr"><span class="state ${st}">${st === "working" ? "Working" : st === "waiting" ? "New reply" : "Idle"}</span><button class="x" data-close="${s.id}" aria-label="Close this pane" title="Close pane">×</button></div></div>
   <div class="msgs" data-for="${s.id}">${body}</div>
   <div class="helpers" data-helpers="${esc(s.id)}">${helpersHTML(s.id)}</div>
   <form class="composer" data-send="${s.id}" data-p="${sp.id}"><textarea id="say-${s.id}" rows="1" placeholder="Message ${esc(s.name)}…  (! runs a command)"></textarea>${live?.active ? `<button type="button" class="btn stop" data-stop="${s.id}" aria-label="Stop" title="Stop">${I.stop}</button>` : ""}<button class="btn primary" aria-label="Send" disabled>${I.send}</button></form></section>`;
}
/* ---------- Helper agents (subagents) at the bottom of each pane ---------- */
const dur = (a, b) => { const s = Math.max(0, Math.round((new Date(b || Date.now()) - new Date(a)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
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
  b.querySelectorAll("[data-pane]").forEach((x) => x.addEventListener("focusin", () => { if (S.focus[key] !== x.dataset.pane) { S.focus[key] = x.dataset.pane; b.querySelectorAll(".pane-c").forEach((y) => y.classList.toggle("focus", y === x && S.panes[key].length > 1)); } }));
  wireHelpers(b);
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
  b.querySelectorAll("[data-send]").forEach((form) => {
    const sid = form.dataset.send, ta = form.querySelector("textarea"), btn = form.querySelector('button[aria-label="Send"]');
    try { const d = sessionStorage.getItem("draft-" + sid); if (d) { ta.value = d; btn.disabled = false; } } catch {}
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
    grow();
    ta.oninput = () => { btn.disabled = !ta.value.trim(); grow(); try { sessionStorage.setItem("draft-" + sid, ta.value); } catch {} };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault(); const v = ta.value.trim(); if (!v) return;
      if (v.startsWith("!")) { // like ! in Claude Code: run it in a real terminal, output goes with the next message
        try { await api("/api/shell", { project: form.dataset.p, session: sid, cmd: v.slice(1) }); ta.value = ""; try { sessionStorage.removeItem("draft-" + sid); } catch {} toast("Opened in Terminal. Its output lands here when it finishes."); refresh(); }
        catch (err) { toast(err.message, true); }
        return;
      }
      const list = S.msgs[sid]?.list || []; list.push({ who: "me", text: v, at: new Date().toISOString() });
      S.msgs[sid] = { ...(S.msgs[sid] || {}), list };
      ta.value = ""; try { sessionStorage.removeItem("draft-" + sid); } catch {}
      render();
      try { await api("/api/send", { project: form.dataset.p, session: sid, text: v }); }
      catch (err) { toast(err.message, true); ta.value = v; }
    };
  });
}

refresh();
connect();

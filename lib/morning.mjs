// The morning run (Diogo, 5 Nov 2026: work fell behind because "later" steps lived only inside chats).
// Once a day at 8:00 it goes through every project's board:
//  - cards Claude is meant to do that are due, late, stalled, or a check that's due go back to the chat
//    that owns them (the card's own chat, else its track's chat), to be done, measured or re-dated;
//  - open cards with no date are sent back to be dated;
//  - what waits on Diogo becomes one short morning message (late first, then soon, then undated).
// It never does anything that reaches a client or a phone: those cards are only listed for his yes.
import { loadAll, ME } from "./store.mjs";

const CYCLE = { daily: 1, weekly: 7, monthly: 30 };
export const MAX_LINES = 6, STALE_DAYS = 3;
const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const day = (d) => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
export const today = () => day(Date.now());

// The same as the board's "Waiting on Diogo" (needsMe in web/app.js), plus cards that reach a client or a phone.
export const waitsOnMe = (t) => !["done", "sent", "ongoing"].includes(t.status) && ((t.status === "waiting" && norm(t.waitingOn) === norm(ME)) || norm(t.owner) === norm(ME) || (t.reach && ["todo", "doing", "blocked"].includes(t.status)));
const isClaudes = (t) => !waitsOnMe(t) && ["todo", "doing", "blocked", "ongoing"].includes(t.status) && (!t.owner || /claude/i.test(t.owner));
const ongoingDue = (t, d) => t.status === "ongoing" && (!t.lastDone || daysBetween(day(t.lastDone), d) >= (CYCLE[t.every] || 7));

// Why a card of Claude's needs its chat this morning ("" when it doesn't).
function whyNow(t, d) {
  if (t.status === "ongoing") return ongoingDue(t, d) ? `due again (${t.every || "weekly"})` : "";
  if (t.due && t.due < d) return `${daysBetween(t.due, d)} day${daysBetween(t.due, d) === 1 ? "" : "s"} late (due ${t.due})`;
  if (t.due === d) return "due today";
  if (t.status !== "todo" && t.updatedAt && daysBetween(day(t.updatedAt), d) >= STALE_DAYS) return `${t.status === "blocked" ? "blocked" : "no update"} for ${daysBetween(day(t.updatedAt), d)} days`;
  return "";
}

// The chat a card belongs to: its own (also under an earlier id), else its track's chat on this computer.
function chatOf(p, t) {
  const mine = (s) => !s.owner || s.owner === ME;
  const own = t.session && p.sessions.find((s) => (s.id === t.session || (s.previousIds || []).includes(t.session)) && mine(s));
  return own || p.sessions.find((s) => s.track === t.track && mine(s)) || null;
}

export function plan(d = today()) {
  const chats = new Map(), mine = [], orphans = [];
  for (const p of loadAll()) {
    if (p.kind === "sales") continue;
    for (const t of p.todos || []) {
      if (waitsOnMe(t)) { mine.push({ project: p.id, projectName: p.name, id: t.id, title: t.title, due: t.due || "", reach: !!t.reach, priority: t.priority || 2, createdAt: t.createdAt || "" }); continue; }
      if (!isClaudes(t)) continue;
      if (p.shared && t.owner && !/claude/i.test(t.owner)) continue;
      const why = whyNow(t, d), undated = !why && !t.due && t.status === "todo" && t.createdAt && daysBetween(day(t.createdAt), d) >= 2;
      if (!why && !undated) continue;
      const s = chatOf(p, t);
      if (!s) { orphans.push({ project: p.id, id: t.id, title: t.title }); continue; }
      const k = p.id + "|" + s.id, c = chats.get(k) || { project: p.id, projectName: p.name, session: s.id, name: s.name, due: [], undated: [] };
      (why ? c.due : c.undated).push({ id: t.id, title: t.title, why, check: t.check || "", owned: t.session === s.id });
      chats.set(k, c);
    }
  }
  // The morning message: late (oldest first), then due within a week, then undated (most important, oldest first).
  const late = mine.filter((x) => x.due && x.due < d).sort((a, b) => a.due.localeCompare(b.due));
  const soon = mine.filter((x) => x.due && x.due >= d && daysBetween(d, x.due) <= 8).sort((a, b) => a.due.localeCompare(b.due));
  const rest = mine.filter((x) => !late.includes(x) && !soon.includes(x)).sort((a, b) => (a.due ? 1 : 0) - (b.due ? 1 : 0) || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const ordered = [...late.map((x) => ({ ...x, kind: "late", late: daysBetween(x.due, d) })), ...soon.map((x) => ({ ...x, kind: "soon" })), ...rest.map((x) => ({ ...x, kind: "none" }))];
  return { date: d, items: ordered.slice(0, MAX_LINES), more: Math.max(0, ordered.length - MAX_LINES), total: ordered.length, chats: [...chats.values()], orphans };
}

// What a chat is told in the morning.
export function chatMessage(c, d) {
  const due = c.due.slice(0, 8), undated = c.undated.slice(0, 5);
  const lines = [`[Morning run, from the Desk, ${d}] ${due.length ? "Cards of yours that are due, late or stalled:" : ""}`];
  for (const x of due) lines.push(`- [${x.id}] ${x.title} · ${x.why}${x.check ? ` · CHECK: ${x.check}` : ""}`);
  if (c.due.length > due.length) lines.push(`(and ${c.due.length - due.length} more: \`desk status\`)`);
  if (due.length) lines.push(`For each one now: if it's routine and safe, do it and mark it (\`desk todo <id> done\`, or \`desk todo tick <id>\` for a duty). For a CHECK card, measure exactly that first, then act on the result or report it. If it can't be done today, update the card so the board tells the truth: \`desk todo set <id> --due YYYY-MM-DD\`, \`desk todo <id> blocked --why "…"\` or \`desk todo <id> waiting --waiting <name>\`.`);
  if (undated.length) lines.push(`These have no date yet; give each one (\`desk todo set <id> --due YYYY-MM-DD\`, and \`--check "…"\` if it waits on a condition): ${undated.map((x) => `[${x.id}] ${x.title}`).join("; ")}.`);
  lines.push(`Never do anything that reaches a client or a phone on your own (messages, client-facing changes, invoices, anything a worker's phone gets): put it on the board as waiting on ${ME} with \`--reach yes\`; ${ME} gets it in the morning message. Reply in one short line when you're done.`);
  return lines.join("\n");
}

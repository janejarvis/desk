// Sales leads, shared between Diogo and João: one small JSON file per lead in SHARED/sales/leads,
// so two people changing different leads never touch the same file. The stages, owners and lost
// reasons are the old Oversight's (lib/crm there), carried over on 2 Nov 2026.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SHARED, ME } from "./store.mjs";

export const DIR = join(SHARED, "sales", "leads");
export const STAGES = [["new", "New lead"], ["audit", "Audit sent"], ["contacted", "Contacted"], ["booked", "Call booked"], ["held", "Call held"], ["proposal", "Proposal sent"], ["trial", "Trial"], ["negotiation", "Negotiation"], ["won", "Won"], ["lost", "Lost"], ["notlead", "Not a lead"]];
export const STAGE = Object.fromEntries(STAGES);
export const LOST = ["price", "timing", "competitor", "not a fit", "no reply"];
export const NOT_LEAD = ["selling to us", "spam / suspicious", "job application", "not a real enquiry"];
export const SERVICES = { ads: "Google Ads", website: "Website", seo: "Local SEO", care: "Website care" };
export const SOURCES = { outbound: "Outreach", form: "Website form", booking: "Booking page", "instant audit": "Instant audit", manual: "Added by hand", referral: "Referral" };

const fail = (m) => { throw Object.assign(new Error(m), { user: true }); };
const now = () => new Date().toISOString();
const path = (id) => join(DIR, id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");

export function list() {
  let files = []; try { files = readdirSync(DIR).filter((f) => f.endsWith(".json")); } catch {}
  return files.map((f) => { try { return JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => (b.stageAt || b.created || "").localeCompare(a.stageAt || a.created || ""));
}
export function get(id) { try { return JSON.parse(readFileSync(path(id), "utf8")); } catch { fail(`No lead ${id}.`); } }
export function put(l) { mkdirSync(DIR, { recursive: true }); const t = path(l.id) + ".tmp"; writeFileSync(t, JSON.stringify(l, null, 2) + "\n"); renameSync(t, path(l.id)); return l; }
const log = (l, kind, text) => { (l.timeline ||= []).push({ at: now(), kind, text: String(text).slice(0, 600), by: ME }); return l; };

// Finds a lead by id or by (part of) its company or person name.
export function find(q) {
  const s = String(q || "").toLowerCase().trim(); if (!s) fail("Which lead?");
  const all = list();
  return all.find((l) => l.id === q) || all.find((l) => (l.company || l.name || "").toLowerCase() === s)
    || (() => { const m = all.filter((l) => `${l.company} ${l.name}`.toLowerCase().includes(s)); if (m.length === 1) return m[0]; if (m.length > 1) fail(`"${q}" matches ${m.length} leads: ${m.slice(0, 5).map((l) => l.company || l.name).join(", ")}…`); return null; })()
    || fail(`No lead matches "${q}".`);
}

export function add(f) {
  const company = String(f.company || "").trim(), name = String(f.name || "").trim();
  if (!company && !name) fail("Give the lead a company or a name.");
  const email = String(f.email || "").trim().toLowerCase();
  if (email && list().some((l) => (l.email || "").toLowerCase() === email)) fail(`There's already a lead with ${email}.`);
  const l = { id: "l-" + randomUUID().slice(0, 8), company, name, email, phone: f.phone || "", website: f.website || "", source: { kind: f.source || "manual" }, owner: f.owner || ME, stage: "new", stageAt: now(), services: [], created: now(), timeline: [] };
  log(l, "created", f.note ? `Added by hand: ${f.note}` : "Added by hand");
  return put(l);
}

// Changes a lead: stage (with the lost / not-a-lead reason), owner, services, next step, a note.
export function set(id, f) {
  const l = get(id);
  if (f.stage) {
    if (!STAGE[f.stage]) fail(`A stage is one of: ${STAGES.map((s) => s[0]).join(", ")}.`);
    if (f.stage === "lost" && !f.reason) fail(`Why was it lost? (${LOST.join(", ")})`);
    if (f.stage !== l.stage) { log(l, "stage", `${STAGE[l.stage] || l.stage} → ${STAGE[f.stage]}${f.reason ? ` (${f.reason})` : ""}`); l.stage = f.stage; l.stageAt = now(); }
    if (f.stage === "lost") l.lost = { reason: f.reason, at: now() };
    if (f.stage === "notlead") l.notLead = f.reason || "not a real enquiry";
  }
  if (f.owner && f.owner !== l.owner) { log(l, "owner", `Owner: ${f.owner}`); l.owner = f.owner; }
  if (f.services) l.services = f.services.filter((x) => SERVICES[x]);
  if (f.next !== undefined) { l.next = f.next ? { text: String(f.next).slice(0, 200), due: f.due || "" } : null; if (f.next) log(l, "next", `Next: ${f.next}${f.due ? ` (${f.due})` : ""}`); }
  if (f.note) log(l, "note", f.note);
  for (const k of ["company", "name", "email", "phone", "website"]) if (f[k] !== undefined) l[k] = String(f[k]).trim();
  return put(l);
}

// The numbers the Sales page shows, worked out from the leads.
export function numbers(ls = list()) {
  const open = (l) => !["won", "lost", "notlead"].includes(l.stage);
  const reached = (l, s) => STAGES.findIndex((x) => x[0] === l.stage) >= STAGES.findIndex((x) => x[0] === s) && !["lost", "notlead"].includes(l.stage);
  const counted = ls.filter((l) => l.stage !== "notlead");
  const bySource = {};
  for (const l of counted) {
    const k = l.source?.kind || "manual", r = (bySource[k] ||= { source: SOURCES[k] || k, leads: 0, open: 0, contacted: 0, booked: 0, proposal: 0, won: 0, lost: 0 });
    r.leads++; if (open(l)) r.open++; if (l.stage === "lost") r.lost++;
    for (const s of ["contacted", "booked", "proposal", "won"]) if (reached(l, s)) r[s]++;
  }
  const services = {}; for (const l of counted) { const k = (l.services || []).length ? l.services.map((x) => SERVICES[x] || x).join(" + ") : "Not said yet"; services[k] = (services[k] || 0) + 1; }
  const owners = {}; for (const l of counted) { const o = (owners[l.owner || "?"] ||= { owner: l.owner || "?", open: 0, won: 0 }); if (open(l)) o.open++; if (l.stage === "won") o.won++; }
  return { total: counted.length, notLead: ls.length - counted.length, booked: counted.filter((l) => reached(l, "booked")).length, won: counted.filter((l) => l.stage === "won").length, bySource: Object.values(bySource).sort((a, b) => b.leads - a.leads), services, owners: Object.values(owners) };
}

export const outreachFile = () => join(SHARED, "sales", "outreach.json");
export function outreach() { try { return JSON.parse(readFileSync(outreachFile(), "utf8")); } catch { return null; } }
export const ready = () => existsSync(DIR);

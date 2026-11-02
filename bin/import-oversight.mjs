#!/usr/bin/env node
// One-off: brings Blendd's sales out of the old Oversight (turned off on 2 Nov 2026) into the shared
// Sales area: every lead with its history and emails, the audit PDFs, and a snapshot of the outreach.
// Safe to run again: it rewrites what it imported and keeps changes made on the Desk since.
//   node bin/import-oversight.mjs [path to oversight-data]
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SHARED, update, expand } from "../lib/store.mjs";
import { createHash } from "node:crypto";
import * as leads from "../lib/leads.mjs";

const OV = process.argv[2] || join(homedir(), "PACE-projects", "Oversight", "oversight-data");
const C = join(OV, "clients", "blendd-2");
const json = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const OWNER = { diogo: "Diogo", joao: "João" };

const crm = Object.values(json(join(OV, "studio", "crm.json"), { leads: {} }).leads).filter((l) => l.client === "blendd-2");
const box = json(join(C, "outbox.json"), []); const mails = Array.isArray(box) ? box : Object.values(box);
const auditsDir = join(C, "proposals"), audits = existsSync(auditsDir) ? readdirSync(auditsDir).filter((f) => f.endsWith(".pdf")) : [];
const outDir = join(SHARED, "sales", "audits"); mkdirSync(outDir, { recursive: true });

const have = new Map(leads.list().map((l) => [l.id, l]));
let n = 0, copied = 0;
for (const o of crm) {
  const id = "ov-" + String(o.id).split(":").pop().slice(0, 24);
  const email = String(o.email || "").toLowerCase();
  const sent = mails.filter((m) => (m.to || []).some((t) => String(t.address || "").toLowerCase() === email && email))
    .map((m) => ({ at: m.created, subject: m.subject, state: m.state, text: String(m.text || "").slice(0, 4000) }))
    .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  const mine = o.folder ? audits.filter((f) => f.startsWith(`auditoria-${o.folder}-`)).sort() : [];
  const files = [];
  for (const f of mine) { const to = join(outDir, f); if (!existsSync(to)) { copyFileSync(join(auditsDir, f), to); copied++; } files.push({ path: `shared:sales/audits/${f}`, name: f, at: statSync(to).mtime.toISOString() }); }
  const reads = Math.max(0, ...(o.timeline || []).map((t) => +((t.text || "").match(/Audit read \((\d+) time/)?.[1] || 0)));
  const l = {
    id, company: o.company || "", name: o.name || "", email: o.email || "", phone: o.phone || "", website: o.website || "",
    source: { kind: o.source?.kind || "manual", ...(o.source?.trade ? { trade: o.source.trade } : {}), ...(o.source?.from ? { from: o.source.from } : {}), ...(o.source?.campaign ? { campaign: o.source.campaign } : {}), ...(o.source?.keyword ? { keyword: o.source.keyword } : {}) },
    owner: OWNER[o.owner] || o.owner || "Diogo", stage: o.stage, stageAt: o.stageAt, services: o.services || [], investment: o.investment || "",
    created: o.created, timeline: o.timeline || [], emails: sent, audits: files, auditReads: reads,
    ...(o.lost ? { lost: o.lost } : {}), ...(o.notLead ? { notLead: o.notLead } : {}), ...(o.trial ? { trial: o.trial } : {}), ...(o.meeting ? { meeting: o.meeting } : {}),
    next: o.next ? { text: o.next.what, due: o.next.date || "" } : null,
    optedOut: (o.timeline || []).some((t) => /\bremov|opted out|não quero|unsubscribe/i.test(t.text || "")),
    importedAt: new Date().toISOString(), fromOversight: o.id,
  };
  // What was done on the Desk is never undone by a refresh: its history entries (marked desk: true) are
  // kept, and a stage, owner or next step set on the Desk after Oversight's last change wins.
  const was = have.get(id), desk = (was?.timeline || []).filter((t) => t.desk);
  if (was && desk.length) {
    l.timeline = [...(o.timeline || []), ...desk].sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    const last = (k) => desk.filter((t) => t.kind === k).map((t) => t.at).sort().pop() || "";
    const ovStage = (o.timeline || []).filter((t) => t.kind === "stage").pop();   // "desk": the bridge copied a Desk move there
    if (last("stage") > (o.stageAt || "") || ovStage?.by === "desk") Object.assign(l, { stage: was.stage, stageAt: was.stageAt, lost: was.lost, notLead: was.notLead });
    if (last("owner")) l.owner = was.owner;
    if (last("next") > (o.next?.set || "")) l.next = was.next;
    if (was.services?.length && !(o.services || []).length) l.services = was.services;
  }
  leads.put(l); n++;
}

// The outreach, as it stood: what was sent and when, what was waiting, the inboxes and their limits.
const client = json(join(C, "client.json"), {});
const ob = mails.filter((m) => m.state !== "draft");
const byDay = {}; for (const m of ob.filter((m) => m.state === "sent")) { const d = (m.created || "").slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
const snap = {
  at: new Date().toISOString(), from: "the outreach bridge (the old Oversight's outreach code, run on its own)",
  sent: ob.filter((m) => m.state === "sent").length, waiting: ob.filter((m) => m.state === "waiting").length, held: ob.filter((m) => m.state === "held").length, stopped: ob.filter((m) => m.state === "stopped").length,
  firstSent: Object.keys(byDay).sort()[0] || null, byDay,
  inboxes: (client.outbound?.inboxes || []).map((i) => ({ address: i.address, dailyCap: i.dailyCap || null, rampStart: i.rampStart || null })),
  perWeek: client.outbound?.perWeek || null, trades: client.outbound?.trades || [],
  rules: [
    "Company addresses only (info@, geral@…), never a person's.",
    "At most two follow-ups (3 and 10 working days); one short one the same day if they read the audit.",
    "Any no or \"remover\" stops everything to them, forever.",
    "Bounces over 3% in 30 days, or one spam complaint, pauses it.",
  ],
};
const { writeFileSync } = await import("node:fs");
writeFileSync(leads.outreachFile(), JSON.stringify(snap, null, 2) + "\n");
// The audits also show on the Sales Files tab.
const all = leads.list();
update("sales", (p) => {
  p.files = (p.files || []).filter((f) => !String(f.id).startsWith("au-"));
  for (const l of all) for (const a of l.audits || []) p.files.push({ id: "au-" + createHash("sha1").update(a.name).digest("hex").slice(0, 10), path: expand(a.path), title: `Audit · ${l.company || l.name}`, kind: "pdf", at: a.at, track: "sales", source: "oversight" });
});
console.log(`Imported ${n} leads, copied ${copied} audit PDFs (${audits.length} in Oversight), outreach snapshot: ${snap.sent} sent.`);

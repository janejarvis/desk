#!/usr/bin/env node
// desk-hook.mjs — keeps Diogo's Desk current from every Claude Code session, without being asked.
// Replaces the work-board hook (2026-10-29: Diogo moved every project onto the Desk).
//
//   SessionStart: a session on the Desk is told its project and track and how to use `desk`.
//     A session in a project's folder that isn't on the Desk yet is told how to join.
//   Stop: a Desk session whose turn changed things but never ran `desk` is sent back ONCE to
//     update the board. At most once an hour, never twice in a row (stop_hook_active).
//
// Never runs for headless runs (`claude -p`: the Desk tells those itself), temp folders, or when
// DESK_HOOK_OFF=1. Never fails a session: every path exits 0.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deskRules } from "../lib/rules.mjs";
import { DATA, ME } from "../lib/store.mjs";

const HOME = homedir();
const STATE = join(HOME, ".claude", "desk-hook");
const QUIET_MS = 60 * 60 * 1000;
const expand = (p) => (p || "").replace(/^~(?=[\\/]|$)/, HOME);

function projects() {
  try { return readdirSync(DATA).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(DATA, f), "utf8"))); } catch { return []; }
}
export function locate(sid, cwd, ps) {
  for (const p of ps) { const s = p.sessions.find((x) => x.id === sid || (x.previousIds || []).includes(sid)); if (s) return { p, s }; }
  const byFolder = ps.filter((p) => p.folder !== "~" && (cwd === expand(p.folder) || cwd.startsWith(expand(p.folder) + "/")));
  return byFolder.length === 1 ? { p: byFolder[0], s: null } : null;
}

export const rules = (p, s) => deskRules(p, s);

const joinHint = (p) => `This folder belongs to ${p.name} on ${ME}'s Desk (the project app), but this session isn't on it. If this session works on ${p.name}, put it on the Desk with \`desk join --track "<${p.tracks.map((t) => t.name).join(" | ")}>" --name "<short name for what it does>"\`, then keep its to-dos current with \`desk\` (see \`desk help\`).`;

const READ_ONLY_TOOLS = /^(Read|Grep|Glob|LS|WebSearch|WebFetch|ToolSearch|Skill|AskUserQuestion|TodoWrite|TaskList|TaskGet|ListAgents|ScheduleWakeup|EnterPlanMode|ExitPlanMode|ArtifactComments|ReportFindings)$/;
const READ_ONLY_BASH = /^\s*(cd [^;&|]+(&&|;)\s*)?(cat|ls|head|tail|grep|rg|find|stat|wc|sed -n|awk|echo|pwd|which|file|du|df|git (status|log|diff|show|branch)|jq|sort|uniq|date|env|printenv|ps|lsof)\b/;
const isDesk = (c) => c?.name === "Bash" && /(^|[;&|(\s])desk\s+(todo|milestone|meeting|track|join|file)\b/.test(String(c.input?.command || ""));
export function isWork(c) {
  const n = c?.name || "";
  if (READ_ONLY_TOOLS.test(n)) return false;
  if (n === "Bash") return !READ_ONLY_BASH.test(String(c.input?.command || ""));
  if (n === "Artifact") return !["read", "list", "quickstart"].includes(c.input?.action);
  if (n === "ArtifactData") return !["get", "list", "query"].includes(c.input?.action);
  if (n.startsWith("mcp__")) return !/(screenshot|read_page|get_page_text|find|tabs_context|list_|read_console|read_network|zoom)/i.test(n);
  return true;
}
// This turn: work done, and whether `desk` was run. Walks back to the last real prompt.
export function readTurn(lines) {
  let work = 0, desk = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]; if (!l || l[0] !== "{") continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain) continue;
    const m = o.message ?? {};
    if (m.role === "assistant" && Array.isArray(m.content)) { for (const c of m.content) if (c?.type === "tool_use") { if (isDesk(c)) desk = true; else if (isWork(c)) work++; } continue; }
    if (m.role === "user") {
      const c = m.content;
      if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) continue;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
      if (t && !t.startsWith("<") && !t.startsWith("Caveat") && !t.startsWith("Stop hook feedback")) break;
    }
  }
  return { work, desk };
}

const FROM_DESK = !!process.env.DESK_PROJECT; // a message sent from the Desk (claude -p, rules attached)
function skip(cwd) {
  if (process.env.DESK_HOOK_OFF === "1") return true;
  if (/^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || "") && !FROM_DESK) return true;
  return /^(\/private)?\/(tmp|var\/folders)\//.test(cwd);
}

if (process.argv.includes("--self-test")) {
  const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) process.exitCode = 1; };
  const ps = [{ name: "LQA", folder: "~/Projects/LQA", tracks: [{ id: "r", name: "Retainer" }], sessions: [{ id: "S1", track: "r", name: "PMS", previousIds: ["S0"] }] }];
  ok(locate("S1", "/x", ps)?.s?.name === "PMS", "finds a session by id");
  ok(locate("S0", "/x", ps)?.s?.name === "PMS", "finds a session by an earlier id");
  ok(locate("S9", join(HOME, "Projects/LQA/a"), ps)?.s === null, "finds the project by folder");
  ok(locate("S9", HOME, ps) === null, "home folder is no project");
  const L = (o) => JSON.stringify(o);
  const turn = [L({ message: { role: "user", content: "go" } }), L({ message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }, { type: "tool_use", name: "Write", input: {} }] } })];
  ok(readTurn(turn).work === 2 && !readTurn(turn).desk, "counts work, no desk");
  ok(readTurn(turn.concat(L({ message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "desk todo t1 done" } }] } }))).desk, "sees a desk command");
  ok(!readTurn(turn.concat(L({ message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "desk status" } }] } }))).desk, "desk status alone is not an update");
  process.exit();
}

try {
  let p = {}; try { p = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const cwd = p.cwd || process.cwd();
  if (skip(cwd)) process.exit(0);
  const event = p.hook_event_name || p.hookEventName || "";
  const sid = String(p.session_id || p.sessionId || "");
  const hit = locate(sid, cwd, projects());
  if (!hit) process.exit(0);

  if (event === "SessionStart" && FROM_DESK) process.exit(0); // the Desk already attached the rules
  if (event === "SessionStart") {
    const text = hit.s ? rules(hit.p, hit.s) : joinHint(hit.p);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } else if (event === "Stop" && hit.s) {
    if (p.stop_hook_active ?? p.stopHookActive) process.exit(0);
    const path = p.transcript_path ?? p.transcriptPath; if (!path) process.exit(0);
    let lines; try { lines = readFileSync(path, "utf8").split("\n"); } catch { process.exit(0); }
    const { work, desk } = readTurn(lines.slice(-4000));
    const f = join(STATE, sid.replace(/[^\w-]/g, "") + ".json");
    let st = {}; try { st = JSON.parse(readFileSync(f, "utf8")); } catch {}
    const now = Date.now();
    if (desk) { try { mkdirSync(STATE, { recursive: true }); writeFileSync(f, JSON.stringify({ ...st, lastDesk: now })); } catch {} process.exit(0); }
    // From the Desk: every turn that did real work must update it. In a terminal: at most hourly.
    if (work >= 2 && (FROM_DESK || (now - (st.lastDesk || 0) > QUIET_MS && now - (st.lastBounce || 0) > QUIET_MS))) {
      try { mkdirSync(STATE, { recursive: true }); writeFileSync(f, JSON.stringify({ ...st, lastBounce: now })); } catch {}
      process.stdout.write(JSON.stringify({ decision: "block", reason: "This turn changed things but " + ME + "'s Desk wasn't updated. Before ending, bring it up to date with `desk`: this track's to-dos (doing, done, blocked, waiting, sent, new follow-ups), milestones reached or re-dated, and any file you handed over (`desk file add`). If nothing on the Desk actually changed, just end the turn; don't explain.\n\n" + rules(hit.p, hit.s) }));
    }
  }
} catch {}
process.exit(0);

// Reading Claude Code sessions: where a session's transcript lives, what was said in it, and
// whether it is open right now in a terminal (Claude Code's own registry, ~/.claude/sessions).
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./store.mjs";

const PROJECTS = join(HOME, ".claude", "projects");
const REGISTRY = join(HOME, ".claude", "sessions");
const found = new Map();

export function transcriptPath(id, cwd) {
  if (found.has(id) && existsSync(found.get(id))) return found.get(id);
  const guess = cwd && join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl");
  if (guess && existsSync(guess)) { found.set(id, guess); return guess; }
  try {
    for (const d of readdirSync(PROJECTS)) {
      const f = join(PROJECTS, d, id + ".jsonl");
      if (existsSync(f)) { found.set(id, f); return f; }
    }
  } catch {}
  return null;
}

export function lastWrite(id, cwd) {
  const f = transcriptPath(id, cwd);
  try { return f ? statSync(f).mtimeMs : 0; } catch { return 0; }
}

// The end of a file (helper agents' logs: only their last lines matter).
function tail(path, bytes) {
  const size = statSync(path).size, start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

const NOISE = /^(<command-|<local-command|<bash-|<task-notification|<system-reminder|<user-prompt-submit-hook|Caveat:|\[Request interrupted|Stop hook feedback)/;
const stripTags = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

// One transcript line as a chat entry (or null): what she typed, or Claude's text and tool count.
function entry(l) {
  if (!l || l[0] !== "{") return null;
  let o; try { o = JSON.parse(l); } catch { return null; }
  if (o.isSidechain || o.isMeta || o.isCompactSummary) return null;
  const m = o.message, at = o.timestamp || "";
  if (!m) return null;
  if (o.type === "user" && m.role === "user") {
    const c = m.content;
    if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) return null;
    let t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "";
    t = stripTags(t);
    return !t || NOISE.test(t) ? null : { uuid: o.uuid, who: "me", text: t, at };
  }
  if (o.type === "assistant" && Array.isArray(m.content)) {
    const text = m.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n").trim();
    const tools = m.content.filter((x) => x?.type === "tool_use").length;
    return text || tools ? { uuid: o.uuid, who: "claude", text, tools, at } : null;
  }
  return null;
}

// Every transcript is read whole, once, and after that only what was added to it, so the whole
// conversation is always there (Diogo, 1 Nov 2026: "they must never disappear") without
// re-reading a 200 MB file on every change.
const files = new Map(); // path -> { off, rest, list }
function entries(path) {
  let c = files.get(path), size;
  try { size = statSync(path).size; } catch { return c?.list || []; }
  if (!c || size < c.off) files.set(path, (c = { off: 0, rest: "", list: [] }));
  if (size === c.off) return c.list;
  const fd = openSync(path, "r");
  try {
    const CHUNK = 16 * 1024 * 1024, buf = Buffer.alloc(Math.min(CHUNK, size - c.off));
    while (c.off < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - c.off), c.off);
      if (!n) break;
      c.off += n;
      const lines = (c.rest + buf.toString("utf8", 0, n)).split("\n");
      c.rest = lines.pop();
      for (const l of lines) { const e = entry(l); if (e) c.list.push(e); }
    }
  } finally { closeSync(fd); }
  return c.list;
}

// The whole conversation as chat bubbles, across every id the session has had (oldest first):
// a session continued as a copy carries on under a new id, and its earlier talk stays.
// Lines a copy repeats from its original are shown once.
export function messages(ids, cwd) {
  const out = [], seen = new Set();
  for (const id of [].concat(ids)) {
    const f = transcriptPath(id, cwd);
    if (!f) continue;
    for (const e of entries(f)) {
      const key = e.uuid || e.at + e.who + e.text.slice(0, 200), key2 = e.at + e.who + e.text.slice(0, 200);
      if (seen.has(key) || seen.has(key2)) continue;
      seen.add(key); seen.add(key2);
      const last = out[out.length - 1];
      if (e.who === "claude" && last?.who === "claude") {
        if (e.text) last.text = last.text ? last.text + "\n\n" + e.text : e.text;
        last.tools += e.tools; last.at = e.at || last.at;
      } else out.push({ who: e.who, text: e.text, ...(e.who === "claude" ? { tools: e.tools } : {}), at: e.at });
    }
  }
  return out.filter((x) => x.who === "me" || x.text);
}

// Sessions open right now in Claude Code (terminal or app), by session id.
export function live() {
  const map = new Map();
  let files = []; try { files = readdirSync(REGISTRY).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    let r; try { r = JSON.parse(readFileSync(join(REGISTRY, f), "utf8")); } catch { continue; }
    try { process.kill(r.pid, 0); } catch { continue; }
    map.set(r.sessionId, { pid: r.pid, status: r.status, interactive: r.kind === "interactive" && !String(r.entrypoint || "").startsWith("sdk"), cwd: r.cwd });
  }
  return map;
}

// The helper agents (subagents) a session has started: Claude Code keeps each one's log and a
// small meta file in <transcript>/subagents. Recent ones only; state is read from the log itself.
function lastLines(path, bytes = 6000) {
  try { return tail(path, bytes).split("\n").filter((l) => l && l[0] === "{"); } catch { return []; }
}
export function agents(id, cwd, hours = 12) {
  const f = transcriptPath(id, cwd);
  if (!f) return [];
  const dir = f.replace(/\.jsonl$/, "") + "/subagents";
  let files = []; try { files = readdirSync(dir).filter((x) => x.endsWith(".meta.json")); } catch { return []; }
  const out = [];
  for (const m of files) {
    const log = join(dir, m.replace(".meta.json", ".jsonl"));
    let st; try { st = statSync(log); } catch { continue; }
    if (Date.now() - st.mtimeMs > hours * 3600e3) continue;
    let meta = {}; try { meta = JSON.parse(readFileSync(join(dir, m), "utf8")); } catch {}
    let first = {}; try { const fd = openSync(log, "r"); const b = Buffer.alloc(4000); readSync(fd, b, 0, 4000, 0); closeSync(fd); first = JSON.parse(b.toString("utf8").split("\n")[0]); } catch {}
    let done = false, doing = "", endAt = "";
    const lines = lastLines(log);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const c = o.message?.content;
      if (o.type === "assistant" && Array.isArray(c)) {
        const tool = [...c].reverse().find((x) => x?.type === "tool_use");
        if (!tool && o.message.stop_reason === "end_turn") { done = true; endAt = o.timestamp || ""; }
        else if (tool) doing = tool.name;
        break;
      }
    }
    const quiet = Date.now() - st.mtimeMs;
    out.push({
      id: m.replace(/^agent-|\.meta\.json$/g, ""), description: meta.description || "Helper", type: meta.agentType || "",
      depth: meta.spawnDepth || 1, parent: meta.parentAgentId || "", background: meta.requestShape === "background",
      startedAt: first.timestamp || "", endedAt: done ? endAt : "", lastAt: new Date(st.mtimeMs).toISOString(),
      state: done ? "done" : quiet < 5 * 60e3 ? "running" : "stopped", doing: done ? "" : doing,
    });
  }
  return out.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

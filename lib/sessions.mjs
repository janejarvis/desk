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

// Only the end of a long transcript is read: chat panes show the recent conversation.
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

// The conversation as chat bubbles: what she typed, and Claude's text replies. Tool work between
// them is counted, not shown.
export function messages(id, cwd, limit = 60) {
  const f = transcriptPath(id, cwd);
  if (!f) return [];
  let lines; try { lines = tail(f, 4 * 1024 * 1024).split("\n"); } catch { return []; }
  const out = [];
  for (const l of lines) {
    if (!l || l[0] !== "{") continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain || o.isMeta) continue;
    const m = o.message, at = o.timestamp || "";
    if (!m) continue;
    if (o.type === "user" && m.role === "user") {
      const c = m.content;
      if (Array.isArray(c) && c.some((x) => x?.type === "tool_result")) continue;
      let t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "";
      t = stripTags(t);
      if (!t || NOISE.test(t)) continue;
      out.push({ who: "me", text: t, at });
    } else if (o.type === "assistant" && Array.isArray(m.content)) {
      const text = m.content.filter((x) => x?.type === "text").map((x) => x.text).join("\n").trim();
      const tools = m.content.filter((x) => x?.type === "tool_use").length;
      const last = out[out.length - 1];
      if (last && last.who === "claude") {
        if (text) last.text = last.text ? last.text + "\n\n" + text : text;
        last.tools += tools; last.at = at || last.at;
      } else if (text || tools) out.push({ who: "claude", text, tools, at });
    }
  }
  return out.filter((x) => x.who === "me" || x.text).slice(-limit);
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

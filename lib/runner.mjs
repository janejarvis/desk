// Talking to a session from the Desk: each message runs `claude -p` on that session (resume, or a
// fresh session id for a new one) in the session's own folder, and streams the reply back.
// A session that is also open in a terminal is continued as a copy (--fork-session), so the two
// never write into the same conversation; the Desk then follows the copy.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HOME, ROOT } from "./store.mjs";

const running = new Map(); // session id -> { child, queue }

const rules = (project, track) => [
  `This message comes from Diogo's Desk, the app Diogo runs every project from. This session is on project "${project.name}", track "${track}".`,
  `Keep that project's board current with the \`desk\` command as you work: \`desk status\` shows the roadmap and to-dos with their ids; \`desk help\` lists every command. Start work: set its to-do to doing. Finish: done. Stuck: blocked with --why. Need a person: waiting with --waiting <name>. Delivered for feedback: sent with --to <name>. A standing duty done again: \`desk todo tick <id>\`.`,
  `She reads your replies in a narrow chat pane: keep them short and plain.`,
].join("\n");

export const isRunning = (id) => running.has(id);

// send({ session, project, trackName, text, fork }, on) — on(event) gets
// { type: "start" } · { type: "id", id } · { type: "delta", text } · { type: "tool", name } · { type: "done", error? }
export function send(job, on) {
  const r = running.get(job.session.id);
  if (r) { r.queue.push([job, on]); on({ type: "queued" }); return; }
  start(job, on);
}

function start(job, on) {
  const { session, project, trackName, text, fork } = job;
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--append-system-prompt", rules(project, trackName)];
  if (session.started !== false) { args.push("--resume", session.id); if (fork) args.push("--fork-session"); }
  else args.push("--session-id", session.id);
  const env = { ...process.env, DESK_PROJECT: project.id, DESK_TRACK: session.track, PATH: `${join(ROOT, "bin")}:${join(HOME, "bin")}:${join(HOME, ".local", "bin")}:${process.env.PATH || ""}` };
  const child = spawn(process.env.DESK_CLAUDE || "claude", args, { cwd: session.cwd || HOME, env, stdio: ["pipe", "pipe", "pipe"] });
  const entry = { child, queue: [], id: session.id };
  running.set(session.id, entry);
  on({ type: "start" });
  let buf = "", err = "", ended = false, idSeen = false;
  const finish = (error) => {
    if (ended) return; ended = true;
    running.delete(entry.id);
    on({ type: "done", error });
    // Messages typed while it was working go next, in order, to the same (possibly new) session id.
    const [first, ...more] = entry.queue.map(([j, o]) => [{ ...j, session: { ...j.session, id: entry.id, started: true }, fork: false }, o]);
    if (first) { start(...first); running.get(entry.id)?.queue.push(...more); }
  };
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "system" && o.subtype === "init" && o.session_id && !idSeen) {
        idSeen = true;
        if (o.session_id !== entry.id) { running.delete(entry.id); entry.id = o.session_id; running.set(entry.id, entry); on({ type: "id", id: o.session_id }); }
      } else if (o.type === "stream_event" && o.parent_tool_use_id == null) {
        const e = o.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") on({ type: "delta", text: e.delta.text });
        if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") on({ type: "tool", name: e.content_block.name });
        if (e?.type === "message_start") on({ type: "message" });
      } else if (o.type === "result") {
        finish(o.is_error ? (o.result || "Claude stopped with an error.") : undefined);
      }
    }
  });
  child.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  child.on("error", (e) => finish("Couldn't start Claude: " + e.message));
  child.on("close", (code) => finish(code ? (err.trim().split("\n").pop() || `Claude exited with code ${code}.`) : undefined));
  child.stdin.end(text);
}

export function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  r.queue = [];
  r.child.kill("SIGINT");
  setTimeout(() => { try { r.child.kill("SIGKILL"); } catch {} }, 4000);
  return true;
}

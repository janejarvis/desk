#!/usr/bin/env node
// Stands in for `claude -p` in tests: echoes each message back as a streamed reply. With
// --input-format stream-json (how bin/claude-keeper.mjs runs it) it takes one JSON message per line
// and stays open until stdin closes, like Claude Code.
// Words in a message switch on test cases: CUTOFF (a helper stopped at the end), BGTASK (a helper that
// finishes 2 s after the reply and starts a turn of its own), EMPTYFIRST (an empty turn first, as on a
// resume), SIGNEDOUT (an expired sign-in).
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const id = a.includes("--fork-session") ? randomUUID() : (get("--resume") || get("--session-id"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = +(process.env.DESK_FAKE_DELAY || 50);
out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd() });

let busy = Promise.resolve(), bg = 0;
const answerWait = {};
async function turn(input) {
  const cutoff = input.includes("CUTOFF") && !input.includes("When your reply ended");
  if (cutoff) out({ type: "system", subtype: "task_started", task_id: "t-fake", description: "Build the fake thing" });
  if (input.includes("BGTASK")) { const t = "t-bg" + ++bg; out({ type: "system", subtype: "task_started", task_id: t, description: "Fake background build" }); setTimeout(() => { busy = busy.then(async () => { out({ type: "system", subtype: "task_notification", task_id: t, status: "completed", summary: "Fake background build" }); await say("Background build finished."); }); }, +(process.env.DESK_FAKE_BG || 2000)); }
  if (input.includes("EMPTYFIRST")) out({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, session_id: id });
  if (input.includes("ASKQ")) { // asks a question with choices and waits for the answer (bin/claude-keeper.mjs)
    const rid = "rq-" + Date.now(), tu = "tu-" + Date.now();
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: tu, name: "AskUserQuestion", input: {} }] } });
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: tu, input: { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false }] } } });
    const ans = await new Promise((r) => (answerWait[rid] = r));
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tu, content: "answered" }] } });
    await say("You picked " + JSON.stringify(ans.updatedInput?.answers || {})); return;
  }
  if (input.includes("SIGNEDOUT")) { out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed", session_id: id }); return; }
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } });
  if (cutoff) { await say("Got it: " + input.slice(0, 40), false); out({ type: "system", subtype: "task_notification", task_id: "t-fake", status: "stopped", summary: "Build the fake thing" }); result(); return; }
  await say("Got it: " + input.slice(0, 40));
}
async function say(text, end = true) {
  out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
  for (const w of text.match(/.{1,8}/g) || []) { out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } }); await sleep(DELAY); }
  if (end) result(text);
}
const result = (text = "Got it") => out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, session_id: id, env: process.env.DESK_PROJECT + "/" + process.env.DESK_TRACK });

if (a.includes("--input-format") && get("--input-format") === "stream-json") {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { let o; try { o = JSON.parse(line); } catch { continue; } if (o.type === "control_response") { answerWait[o.response?.request_id]?.(o.response?.response || {}); continue; } const c = o.message?.content; const text = typeof c === "string" ? c : ""; busy = busy.then(() => turn(text)); }
  await busy;
} else {
  let input = ""; for await (const c of process.stdin) input += c;
  await turn(input);
}

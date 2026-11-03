#!/usr/bin/env node
// Stands in for `claude -p` in tests: echoes the message back as a streamed reply.
import { randomUUID } from "node:crypto";
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
let input = ""; for await (const c of process.stdin) input += c;
const id = a.includes("--fork-session") ? randomUUID() : (get("--resume") || get("--session-id"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd() });
const cutoff = input.includes("CUTOFF") && !input.includes("When your reply ended");
if (cutoff) out({ type: "system", subtype: "task_started", task_id: "t-fake", description: "Build the fake thing" });
if (input.includes("EMPTYFIRST")) out({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, session_id: id }); // like a resume that first answers a leftover background-job note
if (input.includes("SIGNEDOUT")) { out({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed", session_id: id }); process.exit(0); }
out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } });
for (const w of ["Got ", "it: ", input.slice(0, 40)]) { out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } }); await new Promise((r) => setTimeout(r, +(process.env.DESK_FAKE_DELAY || 50))); }
if (cutoff) out({ type: "system", subtype: "task_notification", task_id: "t-fake", status: "stopped", summary: "Build the fake thing" });
out({ type: "result", subtype: "success", is_error: false, result: "Got it", num_turns: 1, session_id: id, env: process.env.DESK_PROJECT + "/" + process.env.DESK_TRACK });

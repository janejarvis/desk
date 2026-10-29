#!/usr/bin/env node
// Stands in for `claude -p` in tests: echoes the message back as a streamed reply.
import { randomUUID } from "node:crypto";
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
let input = ""; for await (const c of process.stdin) input += c;
const id = a.includes("--fork-session") ? randomUUID() : (get("--resume") || get("--session-id"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: id, cwd: process.cwd() });
out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } } });
for (const w of ["Got ", "it: ", input.slice(0, 40)]) { out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } }); await new Promise((r) => setTimeout(r, 50)); }
out({ type: "result", subtype: "success", is_error: false, session_id: id, env: process.env.DESK_PROJECT + "/" + process.env.DESK_TRACK });

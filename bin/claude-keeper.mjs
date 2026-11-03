#!/usr/bin/env node
// Runs one Desk reply: Claude Code in stream mode, kept open while helpers or background commands it
// started are still working, so they finish instead of being stopped when the reply ends (Diogo, 3 Nov
// 2026: "why was the helper stopped? that can't happen!"). It is started detached, so it outlives a Desk
// restart. The first message comes on stdin; later ones (sent while it waits) and the order to close
// come as JSON lines in DESK_KEEPER_IN: { "text": "…" } or { "close": true }. lib/runner.mjs decides.
//   node claude-keeper.mjs <claude command> [claude args…]
import { spawn } from "node:child_process";
import { openSync, readSync, fstatSync, closeSync, existsSync, unlinkSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const IN = process.env.DESK_KEEPER_IN;
let first = ""; for await (const c of process.stdin) first += c;

const child = spawn(cmd, [...args, "--input-format", "stream-json"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
child.on("error", (e) => { process.stderr.write(String(e.message) + "\n"); process.exit(1); });
child.stdin.on("error", () => {});
const say = (text) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
say(first);

let off = 0, closed = false;
const close = () => { if (!closed) { closed = true; child.stdin.end(); } };
const poll = setInterval(() => {
  if (!IN || !existsSync(IN)) return;
  const fd = openSync(IN, "r");
  try {
    const size = fstatSync(fd).size; if (size <= off) return;
    const b = Buffer.alloc(size - off); readSync(fd, b, 0, b.length, off); off = size;
    for (const l of b.toString("utf8").split("\n")) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.close) close(); else if (!closed && o.text) say(o.text);
    }
  } finally { closeSync(fd); }
}, 300);
// If nobody ever says close (the Desk gone for good), give up after six hours.
setTimeout(close, 6 * 3600e3).unref();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { try { child.kill(s); } catch {} });
child.on("exit", (code) => { clearInterval(poll); try { if (IN) unlinkSync(IN); } catch {} process.exit(code ?? 1); });

// Claude in Chrome for every chat (Diogo, 12 Nov 2026: "we keep getting problems with chrome extension, no
// connection"). The extension reaches Claude through a small host Chrome starts for it, which opens a socket in
// /tmp/claude-mcp-browser-bridge-<user>/<pid>.sock. No live socket = no extension, usually because Chrome isn't
// running (closed, or crashed when the disk filled). The Desk starts Chrome in the background when it's missing,
// and `desk chrome` lets a chat check and wake it before it gives up.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";

const DIR = join("/tmp", `claude-mcp-browser-bridge-${userInfo().username}`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const connected = () => { try { return readdirSync(DIR).some((f) => f.endsWith(".sock") && alive(+f.replace(".sock", ""))); } catch { return false; } };
const chromeRunning = () => { try { execFileSync("pgrep", ["-f", "Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=" + join(process.env.HOME || "", "Library/Application Support/Google/Chrome")], { stdio: "ignore" }); return true; } catch { try { execFileSync("pgrep", ["-x", "Google Chrome"], { stdio: "ignore" }); return true; } catch { return false; } } };
const startChrome = () => new Promise((r) => execFile("open", ["-g", "-a", "Google Chrome"], () => r()));

// Checks, wakes Chrome if needed, and waits up to `wait` ms for the extension. Returns { ok, what }.
export async function ensure({ wait = 25000 } = {}) {
  if (process.platform !== "darwin") return { ok: connected(), what: "Only checked on the Mac." };
  if (connected()) return { ok: true, what: "The Chrome extension is connected." };
  const was = chromeRunning();
  await startChrome();
  for (let t = 0; t < wait; t += 1000) { if (connected()) return { ok: true, what: was ? "Chrome was open but its extension was asleep; it's connected now." : "Chrome wasn't running; the Desk started it and the extension is connected now." }; await new Promise((r) => setTimeout(r, 1000)); }
  return { ok: false, what: was ? "Chrome is open but its Claude extension doesn't answer. Diogo needs to click the Claude icon in Chrome's toolbar once (and sign in if it asks)." : "Chrome didn't start. Diogo needs to open Chrome." };
}

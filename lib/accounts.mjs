// Separate sign-ins per project, for tools that keep one login per computer (Vercel, for now).
// Diogo has two Vercel accounts, one for LQA and one for everything else, and was signing out and in
// all the time (3 Nov 2026). A project can name the account it uses (p.accounts, e.g. { vercel: "lqa" });
// its runs then find a small wrapper first on PATH that points the tool at that account's own sign-in
// folder (~/.desk-accounts/<tool>/<account>). Projects that name none use the computer's usual sign-in.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { HOME } from "./store.mjs";

export const ACCOUNTS = join(HOME, ".desk-accounts");
export const TOOLS = { vercel: { flag: "--global-config", login: "vercel login" } };
const WIN = process.platform === "win32";
const safe = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
export const accountDir = (tool, name) => join(ACCOUNTS, tool, safe(name));

// The tool's own command, found on PATH outside the Desk's wrappers.
function real(tool) {
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d || d.startsWith(ACCOUNTS)) continue;
    for (const ext of WIN ? [".cmd", ".exe"] : [""]) { const f = join(d, tool + ext); if (existsSync(f)) return f; }
  }
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin"]) if (!WIN && existsSync(join(d, tool))) return join(d, tool);
  return null;
}

// The folder to put first on PATH for this project's runs ("" when it uses the usual sign-ins).
export function shimPath(p) {
  const acc = p?.accounts || {}, tools = Object.keys(acc).filter((t) => TOOLS[t] && safe(acc[t]));
  if (!tools.length) return "";
  const dir = join(ACCOUNTS, "shims", safe(p.id)); mkdirSync(dir, { recursive: true });
  for (const t of tools) {
    const r = real(t); if (!r) continue;
    const cfg = accountDir(t, acc[t]); mkdirSync(cfg, { recursive: true });
    if (WIN) writeFileSync(join(dir, t + ".cmd"), `@"${r}" ${TOOLS[t].flag} "${cfg}" %*\r\n`);
    else writeFileSync(join(dir, t), `#!/bin/sh\n# ${p.name}: ${t} uses the "${acc[t]}" account (the Desk's per-project sign-ins, lib/accounts.mjs)\nexec "${r}" ${TOOLS[t].flag} "${cfg}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}
export const withShims = (p, path) => { const d = shimPath(p); return d ? d + delimiter + path : path; };

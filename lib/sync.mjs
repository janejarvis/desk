// Keeps the shared folder (Sales and the Blendd clients) the same on Diogo's and João's Desks: a
// private git repo, pulled and pushed every minute in the background. Each lead and each project is
// its own file, so two people rarely touch the same one; when they do, the newer save wins.
// The conversations of shared sessions are copied in too (transcripts/<id>.jsonl), so the other
// person can read them; only the person who started a session can continue it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SHARED, ME, loadAll } from "./store.mjs";
import { transcriptPath } from "./sessions.mjs";

import { readFileSync, writeFileSync } from "node:fs";
import { DESK_HOME, ROOT } from "./store.mjs";
const BASE = process.env.DESK_SHARED_REPO || "https://github.com/janejarvis/blendd-desk-data.git";
// Which GitHub account to use (config.json "github"). On Windows the sign-in helper otherwise keeps
// using whichever account it saved first (2 Nov 2026: João's Blendd Agency account, which has no access,
// and GitHub's "repository not found" never makes it ask again). The name in the address picks the account.
const CONFIG = join(DESK_HOME, "config.json");
const conf = () => { try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return {}; } };
export const githubUser = () => conf().github || "";
export function setGithubUser(u) { const c = conf(); c.github = String(u || "").trim().replace(/^@/, ""); writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n"); return c.github; }
const repoUrl = () => { const u = githubUser(); return u && /^https:\/\//.test(BASE) ? BASE.replace("https://", `https://${encodeURIComponent(u)}@`) : BASE; };
export const REPO = BASE;
export const status = { ok: null, at: null, error: null, busy: false };
// The background sync never asks anyone to sign in (it ran every minute, so a refused sign-in came
// back again and again, 2 Nov 2026); only Connect lets GitHub's sign-in window open.
const envFor = (interactive) => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: interactive ? "auto" : "never" });
// interactive: the person clicked Connect, so GitHub's own sign-in window may open and take its time.
const git = (args, cwd = SHARED, interactive = false) => new Promise((resolve) => execFile("git", args, { cwd, env: envFor(interactive), timeout: interactive ? 600000 : 120000, maxBuffer: 50e6, windowsHide: !interactive }, (err, out, errOut) => resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || "").trim() || (err?.killed ? "timed out" : err?.code === "ENOENT" ? "git is not installed" : "") })));
export const NO_ACCESS = "No access to the shared Sales and Clients yet. Accept the GitHub invite for janejarvis/blendd-desk-data (GitHub emails it to the invited account), then click Connect and sign in to GitHub with that same account.";

// Copies the conversations of this person's sessions in shared projects into the shared folder.
function mirror() {
  for (const p of loadAll()) {
    if (!p.shared) continue;
    for (const s of p.sessions || []) {
      if (s.owner && s.owner !== ME) continue;
      for (const id of [...(s.previousIds || []), s.id]) {
        const from = transcriptPath(id, s.cwd), to = join(SHARED, "transcripts", id + ".jsonl");
        if (!from || from === to) continue;
        try { if (!existsSync(to) || statSync(from).mtimeMs > statSync(to).mtimeMs) { mkdirSync(join(SHARED, "transcripts"), { recursive: true }); copyFileSync(from, to); } } catch {}
      }
    }
  }
}

export async function syncNow({ interactive = false } = {}) {
  if (status.busy) return status;
  status.busy = true;
  try {
    if (!existsSync(join(SHARED, ".git"))) {
      // First time on this computer: get the shared repo. Anything already made here (a client
      // created before the first sync) is kept and sent up with the next push.
      const tmp = SHARED + ".clone-" + process.pid;
      mkdirSync(join(SHARED, ".."), { recursive: true });
      const c = await git(["clone", "-q", repoUrl(), tmp], join(SHARED, ".."), interactive);
      if (!c.ok) { rmSync(tmp, { recursive: true, force: true }); throw new Error(c.err === "git is not installed" ? "Git isn't installed: install Git for Windows (git-scm.com), then click Connect." : !c.err || /auth|denied|403|404|not found|could not read|timed out|terminal prompts/i.test(c.err) ? NO_ACCESS : c.err.split("\n").pop()); }
      if (!existsSync(SHARED)) renameSync(tmp, SHARED);
      else {
        renameSync(join(tmp, ".git"), join(SHARED, ".git")); rmSync(tmp, { recursive: true, force: true });
        await git(["reset", "-q"]);
        const gone = (await git(["ls-files", "-d"])).out.split("\n").filter(Boolean);
        if (gone.length) await git(["checkout", "--", ...gone]);
      }
    }
    if (githubUser()) await git(["remote", "set-url", "origin", repoUrl()]);
    // A small note of how this Desk's sync is doing, so the other person (and Claude) can see it.
    try { mkdirSync(join(SHARED, "status"), { recursive: true }); writeFileSync(join(SHARED, "status", ME.normalize("NFD").replace(/[^A-Za-z0-9]/g, "") + ".json"), JSON.stringify({ who: ME, github: githubUser(), platform: process.platform, version: (() => { try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; } catch { return ""; } })(), at: new Date().toISOString().slice(0, 13) }, null, 2) + "\n"); } catch {}
    mirror();
    await git(["add", "-A"]);
    const st = await git(["status", "--porcelain"]);
    if (st.out) await git(["-c", `user.name=${ME}`, "-c", "user.email=desk@blendd.local", "commit", "-q", "-m", `Desk: ${ME}'s changes`]);
    let pull = await git(["-c", `user.name=${ME}`, "-c", "user.email=desk@blendd.local", "pull", "-q", "--rebase", "--autostash", "origin", "HEAD"], SHARED, interactive);
    // Both changed the same file: keep the newer save (ours, since it was made after their push).
    for (let i = 0; !pull.ok && /conflict/i.test(pull.err + pull.out) && i < 20; i++) {
      const files = (await git(["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
      for (const f of files) { await git(["checkout", "--theirs", "--", f]); await git(["add", "--", f]); }
      pull = await git(["-c", `user.name=${ME}`, "-c", "user.email=desk@blendd.local", "-c", "core.editor=true", "rebase", "--continue"]);
    }
    if (!pull.ok && !/couldn't find remote ref|no such ref|does not appear to be a git repository|empty/i.test(pull.err)) { await git(["rebase", "--abort"]); throw new Error(pull.err.split("\n").pop()); }
    const push = await git(["push", "-q", "origin", "HEAD"]);
    if (!push.ok && !/up-to-date|Everything up-to-date/.test(push.err)) throw new Error(push.err.split("\n").pop());
    Object.assign(status, { ok: true, at: new Date().toISOString(), error: null });
  } catch (e) { Object.assign(status, { ok: false, at: new Date().toISOString(), error: /auth|denied|403|not found|could not read/i.test(e.message) ? NO_ACCESS : e.message }); }
  finally { status.busy = false; }
  return status;
}

// Every minute, and once at start. onChange runs when the pull brought something new.
export function start(onChange) {
  if (process.env.DESK_SYNC === "off") return;
  let head = "";
  const tick = async () => { if (status.error === NO_ACCESS) return; await syncNow(); const h = (await git(["rev-parse", "HEAD"])).out; if (h && h !== head) { if (head) onChange?.(); head = h; } };
  setTimeout(tick, 3000); setInterval(tick, 60e3);
}

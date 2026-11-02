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

export const REPO = process.env.DESK_SHARED_REPO || "https://github.com/janejarvis/blendd-desk-data.git";
export const status = { ok: null, at: null, error: null, busy: false };
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "auto" };
const git = (args, cwd = SHARED) => new Promise((resolve) => execFile("git", args, { cwd, env, timeout: 120000, maxBuffer: 50e6, windowsHide: true }, (err, out, errOut) => resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || err?.message || "").trim() })));

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

export async function syncNow() {
  if (status.busy) return status;
  status.busy = true;
  try {
    if (!existsSync(join(SHARED, ".git"))) {
      // First time on this computer: get the shared repo. Anything already made here (a client
      // created before the first sync) is kept and sent up with the next push.
      const tmp = SHARED + ".clone-" + process.pid;
      mkdirSync(join(SHARED, ".."), { recursive: true });
      const c = await git(["clone", "-q", REPO, tmp], join(SHARED, ".."));
      if (!c.ok) { rmSync(tmp, { recursive: true, force: true }); throw new Error(/auth|denied|403|404|not found|could not read/i.test(c.err) ? "Sign in to GitHub to see the shared Sales and Clients (ask Diogo for access)." : c.err.split("\n").pop()); }
      if (!existsSync(SHARED)) renameSync(tmp, SHARED);
      else {
        renameSync(join(tmp, ".git"), join(SHARED, ".git")); rmSync(tmp, { recursive: true, force: true });
        await git(["reset", "-q"]);
        const gone = (await git(["ls-files", "-d"])).out.split("\n").filter(Boolean);
        if (gone.length) await git(["checkout", "--", ...gone]);
      }
    }
    mirror();
    await git(["add", "-A"]);
    const st = await git(["status", "--porcelain"]);
    if (st.out) await git(["-c", `user.name=${ME}`, "-c", "user.email=desk@blendd.local", "commit", "-q", "-m", `Desk: ${ME}'s changes`]);
    let pull = await git(["-c", `user.name=${ME}`, "-c", "user.email=desk@blendd.local", "pull", "-q", "--rebase", "--autostash", "origin", "HEAD"]);
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
  } catch (e) { Object.assign(status, { ok: false, at: new Date().toISOString(), error: e.message }); }
  finally { status.busy = false; }
  return status;
}

// Every minute, and once at start. onChange runs when the pull brought something new.
export function start(onChange) {
  if (process.env.DESK_SYNC === "off") return;
  let head = "";
  const tick = async () => { await syncNow(); const h = (await git(["rev-parse", "HEAD"])).out; if (h && h !== head) { if (head) onChange?.(); head = h; } };
  setTimeout(tick, 3000); setInterval(tick, 60e3);
}

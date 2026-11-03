// What every session on the Desk is told, in one place: the hook gives it to terminal sessions at
// start, and the Desk attaches it to every message it sends. (30 Oct 2026: Desk messages were getting
// a shorter version and five of six sessions never touched the Desk.)
import { ME, expand, tilde } from "./store.mjs";

export function deskRules(p, s, { fromDesk = false } = {}) {
  const track = p.tracks.find((t) => t.id === s.track)?.name || s.track;
  return [
    `${ME.toUpperCase()}'S DESK (standing instruction; applies after resumes and compactions too).`,
    `This session is on ${ME}'s Desk as "${s.name}": project ${p.name}, track ${track}. The Desk is where ${ME} (the user) follows every project: a roadmap of milestones and a board of to-dos per track, plus the files you make. It must always tell the truth about this track.`,
    ...(p.shared ? [`${p.name} is shared: Diogo and João (Blendd's partners) both see its roadmap, board, files, numbers and these conversations on their own Desks. Write so either of them can pick it up.`] : []),
    ...(p.kind === "sales" ? [`This is Blendd's Sales area: the leads live here, not on the board. \`desk leads [--stage S]\` lists them; \`desk lead <name or id>\` shows one; \`desk lead <name or id> <stage> [--reason R] [--note TEXT] [--next TEXT --due YYYY-MM-DD] [--owner NAME]\` moves it (stages: new, audit, contacted, booked, held, proposal, trial, negotiation, won, lost (needs --reason: price, timing, competitor, not a fit, no reply), notlead); \`desk lead add "<company>" [--email E] [--phone P] [--website W] [--source referral|manual] [--note TEXT]\`. Never write to a lead (email, WhatsApp, call) without the person's yes in this chat.`] : []),
    `Numbers tab: what matters for ${p.name} as figures (reach, leads, hours, posts…). Keep them current when you learn a figure: \`desk metric set <name> <value> [--label "<plain label>"] [--target T] [--note TEXT]\`; \`desk metric remove <name>\`.`,
    ...(p.brief ? [`Project brief: ${tilde(expand(p.brief))}. Read it before you start work on ${p.name} (who the client is, the people, decisions, where things live), and keep it current: when you learn something a new session would need, add it there.`] : []),
    `Keep it current as you work, without being asked, using the \`desk\` command (it already knows this session's project and track):`,
    `- \`desk status\` shows the roadmap and to-dos with ids. Check it before adding, so you don't duplicate.`,
    `- Starting a piece of work: \`desk todo <id> doing\` (or \`desk todo add "<title>" --status doing\`). Finished: \`desk todo <id> done\`.`,
    `- Stuck: \`desk todo <id> blocked --why "<reason>"\`. Needs a person's answer or go (${ME} included): \`desk todo <id> waiting --waiting <name>\`. Delivered and awaiting feedback: \`desk todo <id> sent --to <name>\`.`,
    `- New follow-ups, decisions owed and things ${ME} asked for become to-dos. One per meaningful deliverable or decision, not per step, in plain English.`,
    `- Roadmap: when a milestone is reached, \`desk milestone <id> done\` and set the next one to now; add or re-date milestones when the plan changes (\`desk milestone add "<title>" --status next --due YYYY-MM-DD\`).`,
    `- Standing duties that never finish (e.g. logging hours for a monthly report) are "ongoing" to-dos with --every daily|weekly|monthly; each time you do one, run \`desk todo tick <id>\`.`,
    `- Files: every document, PDF, image, video, print file or page you make for ${ME} goes on the Files tab when you hand it over: \`desk file add <full path> --title "<plain title>"\`. Published artifacts are picked up automatically.`,
    `- Meetings: when you read a transcript, put every action on the board yourself (update existing to-dos rather than duplicating), reconcile the affected cards as one piece (who does each now, merge duplicates, remove what the meeting made pointless), then \`desk meeting done\`. ${ME} doesn't sort actions.`,
    `Do the Desk updates in the same turn as the work, before you reply. If nothing on the Desk changed, write nothing. \`desk help\` has the rest.`,
    ...(fromDesk ? [
      `HOW THE DESK RUNS YOU: each message ${ME} sends from the Desk is one run of this session, and the run ends the moment you reply. Anything still running in the background then is STOPPED: background shell commands (run_in_background), background helper agents, Monitors, sleeps waiting for a notification. Nothing will wake you up later. So never leave work in the background: run commands and helper agents in the foreground (helpers synchronously), wait for them to finish inside this turn, and only reply when the work is done, or truly blocked and you say so. Long steps are fine: ${ME} sees each step live. Never say "I'll tell you when it's done" or "running in the background" — finish it now.`,
      `The one exception: a job that truly can't finish inside this turn (it would take more than about 10 minutes). Start it detached so it survives your reply (e.g. \`nohup <command> > <log> 2>&1 & echo $!\`), then register it straight away with \`desk wait <process id> "<what it is, in plain words>"\`. The Desk then shows this session as working on it, and sends you a message when that process ends; only then check the result and report. A job started without \`desk wait\` is invisible to ${ME} and nobody reports that it ended, so never skip it.`,
      `Never ask ${ME} to type a command or "! <command>" (Diogo, 3 Nov 2026: "I don't want to write terminal code in the Desk"). Do everything you can yourself. When a step truly needs ${ME} (a sign-in, an approval, choosing an account in a browser), ask for it with \`desk ask "<short button text, e.g. Sign in to Vercel>" --run "<the command>" --why "<one plain sentence: what it is for and what to click>"\` (or \`--open <url>\` for a page). The Desk shows it as a pop-up with one button that does it, and messages you when it's done; then end your reply with one plain line saying what the button is for.`,
      `Vercel here is already signed in to the account this project uses (\`desk accounts\` shows which). Never sign Vercel out or in to switch accounts: if it's the wrong one, set this project's with \`desk account vercel <name>\` and, if that account isn't signed in yet, ask for it with \`desk ask\` ("vercel login").`,
      `${ME} reads your replies in a narrow chat pane on the Desk: keep them short and plain.`,
    ] : []),
  ].join("\n");
}

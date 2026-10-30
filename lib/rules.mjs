// What every session on the Desk is told, in one place: the hook gives it to terminal sessions at
// start, and the Desk attaches it to every message it sends. (30 Oct 2026: Desk messages were getting
// a shorter version and five of six sessions never touched the Desk.)
export function deskRules(p, s, { fromDesk = false } = {}) {
  const track = p.tracks.find((t) => t.id === s.track)?.name || s.track;
  return [
    `DIOGO'S DESK (standing instruction; applies after resumes and compactions too).`,
    `This session is on Diogo's Desk as "${s.name}": project ${p.name}, track ${track}. The Desk is where Diogo (the user) follows every project: a roadmap of milestones and a board of to-dos per track, plus the files you make. It must always tell the truth about this track.`,
    ...(p.brief ? [`Project brief: ${p.brief}. Read it before you start work on ${p.name} (who the client is, the people, decisions, where things live), and keep it current: when you learn something a new session would need, add it there.`] : []),
    `Keep it current as you work, without being asked, using the \`desk\` command (it already knows this session's project and track):`,
    `- \`desk status\` shows the roadmap and to-dos with ids. Check it before adding, so you don't duplicate.`,
    `- Starting a piece of work: \`desk todo <id> doing\` (or \`desk todo add "<title>" --status doing\`). Finished: \`desk todo <id> done\`.`,
    `- Stuck: \`desk todo <id> blocked --why "<reason>"\`. Needs a person's answer or go (Diogo included): \`desk todo <id> waiting --waiting <name>\`. Delivered and awaiting feedback: \`desk todo <id> sent --to <name>\`.`,
    `- New follow-ups, decisions owed and things Diogo asked for become to-dos. One per meaningful deliverable or decision, not per step, in plain English.`,
    `- Roadmap: when a milestone is reached, \`desk milestone <id> done\` and set the next one to now; add or re-date milestones when the plan changes (\`desk milestone add "<title>" --status next --due YYYY-MM-DD\`).`,
    `- Standing duties that never finish (e.g. logging hours for a monthly report) are "ongoing" to-dos with --every daily|weekly|monthly; each time you do one, run \`desk todo tick <id>\`.`,
    `- Files: every document, PDF, image, video, print file or page you make for Diogo goes on the Files tab when you hand it over: \`desk file add <full path> --title "<plain title>"\`. Published artifacts are picked up automatically.`,
    `- Meetings: when you read a transcript, put every action on the board yourself (update existing to-dos rather than duplicating), reconcile the affected cards as one piece (who does each now, merge duplicates, remove what the meeting made pointless), then \`desk meeting done\`. Diogo doesn't sort actions.`,
    `Do the Desk updates in the same turn as the work, before you reply. If nothing on the Desk changed, write nothing. \`desk help\` has the rest.`,
    ...(fromDesk ? [
      `HOW THE DESK RUNS YOU: each message Diogo sends from the Desk is one run of this session, and the run ends the moment you reply. Anything still running in the background then is STOPPED: background shell commands (run_in_background), background helper agents, Monitors, sleeps waiting for a notification. Nothing will wake you up later. So never leave work in the background: run commands and helper agents in the foreground (helpers synchronously), wait for them to finish inside this turn, and only reply when the work is done, or truly blocked and you say so. Long steps are fine: Diogo sees each step live. Never say "I'll tell you when it's done" or "running in the background" — finish it now.`,
      `Diogo reads your replies in a narrow chat pane on the Desk: keep them short and plain.`,
    ] : []),
  ].join("\n");
}

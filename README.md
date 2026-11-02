# Desk

Diogo's project app: chats with Claude sessions side by side, a roadmap and a board per track,
and meeting transcripts. Runs on this Mac only (http://127.0.0.1:4848).

**Open it:** `desk open` (starts the server if it isn't running, then opens the browser).

## How it fits together

- `data/projects/<id>.json` — one file per project: tracks, milestones, to-dos, sessions, meetings.
  The page and the `desk` command both change it through `lib/ops.mjs`.
- `server.mjs` — serves `web/`, the API, and a live event stream so edits show up straight away.
- Chats show the whole conversation, across every id the session has had. Each message runs `claude -p --resume <session>` in the session's folder and streams the
  reply (`lib/runner.mjs`). A session that is also open in a terminal is continued as a copy
  (`--fork-session`), and the Desk follows the copy. Conversations are read from the session
  transcripts in `~/.claude/projects` (`lib/sessions.mjs`); "working" comes from Claude Code's own
  registry in `~/.claude/sessions`.
- `bin/desk.mjs` (linked as `~/bin/desk`) — how sessions update the roadmap and board. `desk help`.
- Long jobs: a session that must leave a job running past its reply starts it detached and runs
  `desk wait <pid> "<what>"`. The session shows as working ("Working in the background") until the
  process ends; then the server messages the session so it reports the result (`settleBg()` in server.mjs).
- `hooks/desk-hook.mjs` — in `~/.claude/settings.json` (SessionStart and Stop): tells each Desk
  session its project and track, and sends a turn back once if it changed things without updating
  the Desk. Turn it off for one session with `DESK_HOOK_OFF=1`.
- Transcripts: saved as `YYYY-MM-DD_name.txt` in each project's `transcripts` folder (LQA's own
  `~/Projects/LQA/transcripts`; the others under `transcripts/` here). Word files are converted
  with macOS `textutil` and kept next to the text.

## Checks

- `node hooks/desk-hook.mjs --self-test`
- Server against a copy of the data and a stand-in Claude:
  `DESK_DATA=<copy> DESK_RUN=<empty folder> DESK_PORT=4799 DESK_CLAUDE=$PWD/test/fake-claude.mjs node server.mjs`
  (always give a test server its own DESK_RUN: the live `run/` holds real replies in progress)

## Running

- macOS keeps the Desk running: LaunchAgent `~/Library/LaunchAgents/com.blendd.desk.plist` (starts at
  login, restarts if it stops). `desk restart` restarts it at any time; replies in progress carry on
  (they run outside the server, in `run/`, and a new server picks them up).
- Each project has a brief (`brief` in its data; LQA's own BRIEFING.md, the rest under `briefs/`):
  every session is told to read it first and keep it current.
- Steps a session wasn't allowed to take from the Desk (they need Diogo's OK) show in its pane, with
  "Run it myself (!)". Finished replies notify (browser notification; a Mac notification when no
  Desk page is open).

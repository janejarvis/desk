# Working on the Desk

Read README.md first. What Diogo asked for, in her words: "super intuitive and nice to look at and
easy for claude code to upkeep", "not overkill or overengineered". Hold that line: tracks,
milestones (title, date, done/now/next), to-dos (to do, doing, blocked, waiting on, sent, done),
sessions and meetings. Push back on anything more.

- The look is the glass language of Diogo's earlier tools (see the approved design below):
  white glass, system font, #1d1d1f ink, one blue accent, pill buttons. No counts of to-do / doing
  etc. anywhere but the board's own lanes (Diogo's ruling, 29 Oct 2026).
- No npm packages: plain Node and plain browser JavaScript. (package.json is only for building the
  installable app in app/ with Electron; the Desk itself never imports anything from node_modules.)
- Every data change goes through `lib/ops.mjs`, so the page and the `desk` command follow the
  same rules.
- Never test against the real sessions: use a copy of `data/projects`, an empty `DESK_RUN` folder and `test/fake-claude.mjs`
  (see README). Sending from the Desk to a real session continues that session for real.
- The approved design is the artifact https://claude.ai/artifact/KAW6udsRkTtk1BcVPwtvsT.
- Projects never mix (Diogo's ruling, 29 Oct 2026): a project's page only offers its own people and
  items, and a session on the Desk can only read and change its own project through `desk`
  (`guard()` in bin/desk.mjs). Only the All projects overview shows them together. Keep it so.
- Conversations are shown whole, always (Diogo, 1 Nov 2026: "they must never disappear"): every
  message from the first, across all of a session's ids (`previousIds` + `id`). Never add a message
  limit or read only the end of a transcript; `lib/sessions.mjs` reads each file once and then only
  what was added.
- Three areas (Diogo, 2 Nov 2026): each person's own Projects; Sales; and the Blendd Clients. Sales
  and Clients are shared with João through a private git repo (github.com/janejarvis/blendd-desk-data,
  cloned to the shared folder, `SHARED` in lib/store.mjs; synced every minute by lib/sync.mjs). Never
  put shared data in this repo: the code repo is public. A shared session belongs to whoever started
  it (`owner`); the other person reads it (its transcript is mirrored into the shared folder) but can't
  write to it. Leads are one file each in SHARED/sales/leads (lib/leads.mjs); every project and client
  has a Numbers tab fed by `desk metric`.

# Working on the Desk

Read README.md first. What Diogo asked for, in her words: "super intuitive and nice to look at and
easy for claude code to upkeep", "not overkill or overengineered". Hold that line: tracks,
milestones (title, date, done/now/next), to-dos (to do, doing, blocked, waiting on, sent, done),
sessions and meetings. Push back on anything more.

- The look is the ACE / Oversight V1 glass language (`~/PACE-projects/Oversight/looks/ace-glass.css`):
  white glass, system font, #1d1d1f ink, one blue accent, pill buttons. No counts of to-do / doing
  etc. anywhere but the board's own lanes (Diogo's ruling, 29 Oct 2026).
- No npm packages: plain Node and plain browser JavaScript.
- Every data change goes through `lib/ops.mjs`, so the page and the `desk` command follow the
  same rules.
- Never test against the real sessions: use a copy of `data/projects` and `test/fake-claude.mjs`
  (see README). Sending from the Desk to a real session continues that session for real.
- The approved design is the artifact https://claude.ai/artifact/KAW6udsRkTtk1BcVPwtvsT.
- Projects never mix (Diogo's ruling, 29 Oct 2026): a project's page only offers its own people and
  items, and a session on the Desk can only read and change its own project through `desk`
  (`guard()` in bin/desk.mjs). Only the All projects overview shows them together. Keep it so.

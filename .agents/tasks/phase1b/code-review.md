# Phase 1b final review: APPROVED

Scope: `main...feature/parent-portal-and-invite-limits` (3 code commits + design commits). I read the full diff of firestore.rules and index.html and the test titles. I did not re-run suites. Coder results taken from commit messages: rules 53/53 pass (emulator); client harness 33/33 (jsdom + emulators, temp harness outside the repo, so not reproducible from the repo).

## Checks
- No student self-approval: link (d) approve/deny requires `isSelf(existing().adultUid)`; (a) invite create is adult-only with status `invited`; students can only create `requested` (b) or canonical `accepted` (c2, needs a matching adult invite). Test "2-guards" covers it. Users rules not touched by the diff, so role immutability is intact (no `match /users` change; no role edit path added).
- Pending student leaderboard block: leaderboard rule untouched; "2-guards" test asserts it.
- Privacy hole closed: `adultLinkedTo` now requires status in [accepted, approved]. Tests 1b-a (invited, userid), 1b-b (requested/denied), 1b-c (email invite then canonical accept), 1b-d (code approval, plus unrelated student denied), test 7 reseeded as `accepted`.
- Quota is rules-enforced: doc id and `day` derive from `request.time`; create needs count==1, update needs +1 and <=30; delete denied; `callerRoleIs(teacher,parent)` blocks students; `invitePaired` (existsAfter/getAfter, new link, owner, status invited, `lastLinkId`) ties each bump to exactly one invite, and the link create requires the matching getAfter quota. Tests 4-limit (30 ok, 31st fails), 4-pairing, 4-tamper, 4-day, 4-rollover, 4-who, 4-dup. Rule-call counts: link create ~5, quota write ~5 per batch, below the 20 batch cap, and exercised by the passing tests.
- Client: invite + quota bump in one `runTransaction` (UTC day); limit and clock-skew messages are handled. Offline path is untouched (every new code path is behind `cloud()`/`db` guards). Pending-screen defaults for `renderMyInvites`/`onAcceptInvite`/`onRequestByCode` preserved. Active-student accept skips the pending->active write; approveStudent only activates a genuinely pending student.
- Overlays: `studentInvites` is in the `el` map and in the hardcoded `hideAllOverlays()` array.
- No student email/uid in UI: rows show userid typed by the adult, display name, or "(student)"; progress is grade/level/best/last-played only.
- Files: only index.html, firestore.rules, rules-test/*, design doc, README.md (owner-only role procedure, item 3). No .kiro/, node_modules, logs or backups in the diff. firestore.indexes.json not needed/changed. No script created (it was optional).
- No push/deploy: `git ls-remote` shows no remote branch for this work.

## Non-blocking notes
- The client jsdom harness result (33/33) is not reproducible from the repo; treat it as reported, not independently verified. Browser UI itself was not run by me.
- The emulator checks rules, not the live project; the owner must deploy rules before the client (documented in README).
- Invite ids containing `/` (email with a slash) are rejected; negligible.

# Phase 1 — Three-role identity + cross-role authorization for MathQuest

This change layers a `student`/`teacher`/`parent` identity model and a bidirectional linking flow onto the single-file `index.html` app, adds a committed `firestore.rules` + `firestore.indexes.json` + `firebase.json`, and denormalizes global scores into a world-readable `leaderboard/{uid}` collection so the restrictive new `users` read rule doesn't break the leaderboard. A newly signed-up student is `pending` and excluded from the global leaderboard until a real adult links them, either by accepting an adult's invite (primary, by userid or email) or by typing the adult's shareable code (fallback). Students can still play solo immediately, and the offline/local-only path is untouched and carries no role logic. The review was done by reading the diff, the committed files, and the coder's verification note; no build/test/emulator was run (there is none, and emulator runs are the human's job per the task constraints).

Watch for: (1) **confirmed** — `firestore.rules` and `firestore.indexes.json` are committed but UNTESTED against the live project/emulator this phase; the three `links` composite indexes and every rule branch are reasoning-verified only, so emulator rules-testing and index deployment remain the human's gating step before this is trusted in production. (2) **confirmed** — invite/code-request spam has no rate limiting (deferred to Phase 2 per design §3/§10); a stranger adult can create queue noise a student declines, never activation. Neither is a blocking defect for a Phase-1 local commit.

**Verdict**: APPROVED

## High-level view

The authorization model lives entirely in `firestore.rules`. Every documented attack case (A1–A9, N1–N6, plus the email case-normalization feasibility case) maps to a concrete deny, and the client is written to satisfy the create/update constraints rather than fight them — students self-create forced to `status=='pending'/best==0/approvedBy==null`, role is immutable on all three `users` update branches, and activation is only reachable through a real adult-authored link. The two activation writes (student `acceptInvite`, adult `approveStudent`) both write the `links` doc before the `users` doc, which is exactly what the `acceptableInviteExists`/`approvedLinkExists` helpers need to see at evaluation time.

The email-invite path is the subtle one: the invite id and `targetValue` are stored lowercased, and the rule normalizes the accepting student's stored (verbatim-case) email with `.lower()` at a single point (`callerEmail()`), so all four touch points agree and the path is reachable while still failing closed on any mismatch. The client mirrors this with `toLowerCase()` on both the send and accept sides and `lower(trim(...))` on the discovery query.

On the client, routing is the other place a mistake would bite. `enterGame` branches into exactly three cases (adult → approval desk; pending student → waiting screen + live watch; everything-else → start screen, with a legacy backfill), and the offline/cache/default profile carries no `role` so it lands in branch 3 by construction. The former HIGH finding — the two new overlays must be in both the `el` map and the hardcoded `hideAllOverlays()` sweep — is correctly applied. The live `pending→active` transition is immediate when idle and deferred via a `justActivated` flag consumed at the end of both `gameOver()` and `levelCleared()` so it never interrupts a run.

The leaderboard was decoupled from `users`: `saveProfile` writes `leaderboard/{uid}` only when a main-script eligibility flag is set, the flag is toggled true/false across `enterGame`/`onMyStatus`/`logout`, the read was repointed to the `leaderboard` collection, and the `persistProgress` profile literal was left untouched so the `users` write shape and the create-rule's `best==0` constraint are undisturbed.

The known gap is verification depth, not design: the rules and indexes ship unexercised against the live project, which the coder flagged and which the human must close.

<details>
<summary>Issues (2)</summary>

1. **Rules/indexes untested against live project** — `firestore.rules` and the three `links` composite indexes in `firestore.indexes.json` are reasoning-verified only (no emulator, no deploy, per task constraints). Human must run emulator rules-tests and deploy/build the composite indexes before relying on this in production. Non-blocking for the local Phase-1 commit.
2. **No invite/code-request rate limiting** — a stranger can generate decline-noise in an adult's approval desk; never activation or data exposure. Deferred to Phase 2 (needs a Cloud Function) per design §3/§10. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Authorization model in firestore.rules — every attack case holds

The rules carry the A1–A9 / N1–N6 index comment block atop the file and each case traces to a branch that denies it. The student self-create is forced to `status=='pending' && best==0 && approvedBy==null` (A5), so no fabricated score or pre-set approver can enter. Role is asserted equal to the existing value on all three `users` update branches (A6). Self-update branch (1) additionally pins `status` and `approvedBy` to their existing values, so a student can't self-approve on the ordinary profile-save path (A1). The only student status change is accept branch (2), which requires `existing().role=='student' && existing().status=='pending' && incoming().status=='active'`, `role` unchanged, `onlyStatusAndApprover` limiting the diff to `status/approvedBy/updated` (A8/N2), and `acceptableInviteExists(uid, incoming().approvedBy)` — a real adult-authored `invited`/`accepted` link naming this exact student+adult. Since a student can't author an `invited` link (links branch (a) requires `callerRoleIs(['teacher','parent'])`, N1/N4), the self-forged-invite escalation has no link to stand on.

The adult approve path (users branch 3) requires `request.auth.uid != uid`, `callerRoleIs(['teacher','parent'])`, `approvedLinkExists` (an `exists()`-guarded `approved` link to this adult), `incoming().approvedBy == request.auth.uid`, role unchanged, and `onlyStatusAndApprover`. An adult can only move a link to `approved` on branch (d), which requires `isSelf(existing().adultUid)`, closing A9. `studentUid != adultUid` is asserted on both links create branches (A3). The self-link chain A2 is blocked three independent ways: `linkCodes.create` requires `callerRoleIs([incoming().role])` (a student's own role is `student`), links branch (b) requires `studentUid != adultUid`, and users branch (3) requires a non-self real adult.

Cross-user reads (A4): `users` read is `isSelf(uid) || adultLinkedTo(uid)`, and `adultLinkedTo` only resolves for an adult holding a non-denied deterministic-id link to that student. Other players' scores are reachable only through the world-readable `leaderboard`, which carries no PII beyond display name. The `leaderboard` write rule requires `isSelf(uid)`, the writer's own `users` to be a non-student or `status=='active'`, and `keys().hasOnly(['name','best','level','updated'])`, so a pending student cannot inject a row (A7).

The addressee checks on accept are the N3/N6 guards: userid accept (links branch (c)) requires `existing().studentUid == request.auth.uid` and holds the addressee/adult fields constant; email accept (links branch (c2)) is a *create* of the canonical `{me}_{adultUid}` doc guarded by `emailInviteToMe(adultUid)`, which reconstructs the `email|{adultUid}|{callerEmail()}` id and asserts the invite exists, is `invited`, `targetKind=='email'`, and `targetValue == callerEmail()`. A student cannot accept an invite addressed to someone else's uid or email. N5 (adult forging an invite from another adult) is blocked by branch (a)'s `isSelf(incoming().adultUid)` plus the id-shape assertions (`studentUid+'_'+adultUid` for userid, `'email|'+auth.uid+'|'+targetValue` for email).

### Email-invite normalization is consistent across all four touch points

This was the iteration-6 feasibility fix and it is implemented end to end. The invite id and `targetValue` are written lowercased by the client (`inviteStudent` email branch: `key = raw.toLowerCase()`, id `'email|'+me+'|'+key`), and rule branch (a) asserts `incoming().targetValue == incoming().targetValue.lower()`. On accept, `callerEmail()` returns `get(users/{auth.uid}).data.email.lower()`, and `emailInviteToMe` reconstructs the id and compares `targetValue == callerEmail()` — both lowercased. The client `acceptInvite` email branch writes `targetValue: storedEmail` where `storedEmail = (auth.currentUser.email||"").trim().toLowerCase()`, and the discovery query in `renderMyInvites` passes `myEmail = (storedEmail||"").trim().toLowerCase()`. All four points use the lowercased form, so a mixed-case signup email no longer makes the primary email path unreachable, and any residual mismatch fails closed (no privilege hole).

### Client routing: three-branch enterGame, overlay sweep, live transition

`enterGame` reads `profile.role` and branches: adult (`teacher`/`parent`) → `setLeaderboardEligible(true)` + `showApprovalDesk()`; pending student (`role=='student' && status=='pending'`) → `setLeaderboardEligible(false)`, `showPending()`, `state="pending"`, `unsubMyStatus = watchMyStatus(currentUid, onMyStatus)`; everything else → `setLeaderboardEligible(true)`, start screen, and `backfillRole(currentUid)` when `role` is absent. The offline/cache/default profile (`{name,best,level,grade,speed}`, no `role`) falls into branch 3 by construction, so the local-only fallback keeps zero role logic — no regression to the existing flow. `watchMyStatus(uid, cb)` matches the residual-finding signature exactly and returns a no-op when `db`/`uid` is missing.

The former HIGH finding is resolved: `pendingApproval` and `approvalDesk` are both in the `el` map and both appended to the hardcoded array inside `hideAllOverlays()` (`[... el.leaderboard, el.pendingApproval, el.approvalDesk]`), so the new overlays are swept on every auth/start transition rather than sticking on screen.

The live `pending→active` transition is handled in `onMyStatus(data)`: when `data.status==='active'` and `state!=='playing'` it flips eligibility true, shows the start screen, and tears down the watcher; when `state==='playing'` it sets `justActivated=true` without interrupting. That deferred flag is consumed by an identical 3-line block at the end of both `gameOver()` and `levelCleared()` (hide overlays → start screen → `state="start"` → unsubscribe), so a mid-run activation takes effect at the next natural boundary. `logout()` detaches the watcher, clears `justActivated`, and sets eligibility false, so nothing leaks across sessions.

### Leaderboard decoupling preserves the users write shape

`saveProfile` keeps its unconditional `users/{uid}` merge write with the original destructure (no `role`/`status` added) and then conditionally mirrors `{name,best,level,updated}` into `leaderboard/{uid}` only when the module-scope `leaderboardEligible` flag is true. The flag is owned by the main script via `setLeaderboardEligible` and toggled in `enterGame` (per branch), `onMyStatus` (true on activation), and `logout` (false). The `persistProgress` profile literal is unchanged, so the `users` write shape and the create-rule's `best==0` constraint are undisturbed, and the backfill goes through the distinct `backfillRole` self-update merge rather than `saveProfile`. The leaderboard read (`topScores`) was repointed from `users` to the `leaderboard` collection with the same `orderBy('best','desc')/limit` query; `renderLeaderboardRows` is untouched.

### Accept/approve write ordering matches the rules' read expectations

`acceptInvite` writes the link first (branch (c) update for userid, branch (c2) create for email) and only then the `users` activate; `approveStudent` writes the link (`approved`) before the `users` activate; `denyStudent` writes only the link. This ordering is what `acceptableInviteExists`/`approvedLinkExists` rely on — the link naming student+adult is already present when the `users` write is evaluated. `acceptInvite` never writes `'?'` for `adultRole` (uses `adultRole ?? null`), matching the schema widening to `'teacher'|'parent'|null`.

### Adult provisioning and the fallback code

Adult signup generates a 7-char code from the ambiguity-free alphabet with a 6-try collision check (plus an extremely-unlikely longer fallback), writes `linkCodes/{code} {adultUid, role}`, and stores `linkCode` on the adult's `users` doc; the student-create path writes `status:'pending', approvedBy:null` and no `linkCode`. `requestByCode` uppercases/trims the entered code to match the stored id, resolves the adult, and creates the `{me}_{adultUid}` link in `requested`. The code-table `role` is independently re-verified in the rules against the creator's own `users` role, so a student cannot claim a teacher code entry.

### Test coverage

Not tested at runtime: no browser DOM exercise and no Firestore emulator run — the coder ran only `node --check` on both extracted inline scripts (exit 0) and `JSON.parse` on the two JSON config files. The UI flows (role picker, pending screen, approval desk, live transition) and every rule branch / composite index are reasoning-verified only. This is consistent with the task constraints (no build/test suite exists; emulator runs touch login/network/billing and are the human's job) and with design §11's "composite indexes untested this phase." The manual browser passes in plan.md §D and emulator rules-testing remain for the human; they are flagged, not silently skipped, so this is not a blocking gap for a local Phase-1 commit.

### Bundled changes

Alongside the four code/config deliverables (`index.html`, `firestore.rules`, `firestore.indexes.json`, `firebase.json`), the commit stages this task's own `.agents/` planning/evidence artifacts — not unrelated edits. The stray `index-Original.html`/`index-Crayon-version.html` and `deploy/`/`questions.js` were correctly left untouched.

</details>

<details>
<summary>File map</summary>

- `index.html` — role picker at signup; `#pendingApproval` + `#approvalDesk` overlays + CSS; new `MathQuestCloud` methods (invite/accept/code/approve/deny/watchMyStatus/backfillRole/setLeaderboardEligible/myLinkCode); three-branch `enterGame`, `onMyStatus`, deferred activation in `gameOver()`/`levelCleared()`, logout teardown; leaderboard write gated + read repointed to `leaderboard`.
- `firestore.rules` — new; full authorization model with A1–A9/N1–N6 attack-case index and helpers.
- `firestore.indexes.json` — new; three `links` composite indexes.
- `firebase.json` — new; points firestore rules + indexes (no hosting change).
- `.agents/design/phase1-roles-and-authorization.md`, `.agents/design/design-review.{md,json}`, `.agents/tasks/verification.md` — planning/evidence artifacts.

Full diff: `git diff main` on branch `feature/roles-and-authorization` (commit 77fba67).

</details>

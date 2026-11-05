# Phase 1 — Verification Note (for the reviewer)

Branch: `feature/roles-and-authorization`. First iteration (no `review.json` existed).
Implemented per `.agents/tasks/plan.md` and `.agents/design/phase1-roles-and-authorization.md` (iteration 6).

## What was actually RUN (machine-checked)

1. **JS syntax check (both inline scripts).** Extracted the `<script type="module">` Firebase block and the main-script IIFE from `index.html` into temp files and ran `node --check` on each:
   - module block → exit 0 (no syntax error)
   - main script → exit 0 (no syntax error)
   The temp files and the extractor were deleted afterward.
2. **JSON validity.** `firestore.indexes.json` and `firebase.json` both parse (`JSON.parse` via node) → "JSON OK".

## What was NOT run (and why) — no runtime verification claimed

- **No browser run / no DOM exercise.** This is a headless environment; I did not load `index.html` in a browser, so the UI flows (role picker, pending screen, approval desk, live transition) are **reasoning-verified only**, not runtime-verified. The reviewer/human should still do the manual browser passes in plan.md §D.
- **No Firestore emulator / rules unit tests.** Per the task constraints (no login, no network to the live project, no billing) and because the emulator requires a Java runtime + a first-run network download of the emulator jar, I did **not** run `firebase emulators` or `@firebase/rules-unit-testing`. **`firestore.rules` and `firestore.indexes.json` are committed but UNTESTED against the live project/emulator this phase** (design §11). The three `links` composite indexes behind the adult student-list, the student invite-list, and the email-invite match are likewise untested. Emulator rules-testing is **deferred to the human.**
- **No `firebase deploy` / `firebase login`** and **no `git push`/`pull`/PR**, per constraints. Nothing touched the live project `mathquest-ca395` or billing.

## Reasoning verification performed

### (a) firestore.rules vs. every documented attack case (both flows)
Traced A1–A9 + N1–N6 and the email-normalization feasibility case against the rule branches; every gate holds. Summary:
- **A1** blocked by users self-update branch (1) `incoming().status == existing().status`; the only student status change is branch (2), gated by `acceptableInviteExists` (needs a real adult-authored link).
- **A2** blocked at three gates: `linkCodes.create` `callerRoleIs([incoming().role])`; links (b) `studentUid != adultUid`; users (3) `request.auth.uid != uid` + `callerRoleIs(['teacher','parent'])`.
- **A3** `adultUid != studentUid` on both links create branches (a)/(b).
- **A4** users read = `isSelf(uid) || adultLinkedTo(uid)`; cross-player scores only via world-readable `leaderboard` (no PII).
- **A5** student create forces `status=='pending' && best==0 && approvedBy==null`.
- **A6** `role` immutable on all three users update branches.
- **A7** leaderboard create/update requires own users non-student OR `status=='active'`, plus `keys().hasOnly([...])`.
- **A8** `onlyStatusAndApprover` limits branches (2)/(3) diff to `status/approvedBy/updated`.
- **A9** branch (3) requires `approvedLinkExists` (exists()-guarded, status `=='approved'`); only the adult on a link can set `approved` (branch (d)).
- **N1/N4** links (a) requires `isSelf(adultUid) && callerRoleIs(['teacher','parent'])` — a student cannot author an `invited` link.
- **N2** student accept (users branch 2) is diff-limited + role-immutable + status forced active + `approvedBy` confirmed by `acceptableInviteExists`.
- **N3/N6** userid accept (links c) requires `existing().studentUid == auth.uid`; email accept (links c2) + `emailInviteToMe` reconstruct the id from `callerEmail()` and require `targetValue == callerEmail()`.
- **N5** links (a) requires `isSelf(incoming().adultUid)`; email id must be `'email|'+auth.uid+'|'+targetValue`, userid id must be `studentUid+'_'+adultUid`.
- **Email case-normalization** — `callerEmail()` returns `.lower()`; invite id/`targetValue` stored lowercased (branch (a) asserts `targetValue == targetValue.lower()`); client `listMyInvites` passes `lower(trim(storedEmail))`; `acceptInvite` email branch writes `targetValue` lowercased. All four touch points agree → PRIMARY email path is reachable and fails closed on mismatch.

**Accept ordering** (links-write-first) is honored in the client: `acceptInvite` writes the link (branch c update or c2 create) before the `users` activate; `approveStudent` writes the link before the `users` activate. So `acceptableInviteExists`/`approvedLinkExists` see the link when the `users` write is evaluated.

**Rules-syntax note:** the design's `let path = …` helper form was authored with inline `exists(path)/get(path)` repetition instead (both are valid; `&&` short-circuits so `get()` only runs after `exists()`, and Firestore caches identical `get()`s within one evaluation, so no extra billed reads). Semantics are identical to the design.

### (b) emulator — SKIPPED (see above). Rules are reasoning-verified only; human must emulator-test.

### (c) index.html auth-state routing traced
`startAuthListener` (offline branch shows `#auth`, no role logic) → `onAuthChange` → `enterGame(user)`:
- **Offline / cache-only / default literal:** profile carries no `role` → **branch 3** → start screen, no role logic, `getCached` path intact. No regression.
- **Signed-out:** `showAuth()` → `hideAllOverlays()` (now sweeps the two new overlays) → `#auth`, `state='auth'`.
- **Active student** (`role==='student', status==='active'`) → branch 3, `setLeaderboardEligible(true)`.
- **Pending student** (`role==='student', status==='pending'`) → branch 2, `#pendingApproval`, `state='pending'`, `setLeaderboardEligible(false)`, `watchMyStatus(currentUid, onMyStatus)` wired; Accept/code/solo handlers active; live transition immediate if `state!=='playing'`, else deferred via `justActivated` at `gameOver()`/`levelCleared()`.
- **Teacher / Parent** → branch 1, `#approvalDesk` (invite input, student list, own link code), `setLeaderboardEligible(true)`.
- **Legacy (no role)** → branch 3 + `backfillRole(currentUid)` (distinct merge write via self-update rule branch (1); `best` untouched).

### (d) new overlays correctly hidden (the former HIGH finding)
- `el.pendingApproval` and `el.approvalDesk` were added to the `el` map.
- Both were appended to the hardcoded array inside `hideAllOverlays()`:
  `[el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown, el.help, el.scratch, el.leaderboard, el.pendingApproval, el.approvalDesk]`.
Verified against the real code (not the plan's approximate line numbers).

## Residual-finding checklist (the 4 called out in the task)
1. `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db, USERS, uid), s=>cb(s.data())); }` — implemented verbatim; called as `cloud().watchMyStatus(currentUid, onMyStatus)`.
2. New state `'pending'` is unique — the existing state set is `auth/start/playing/battle/levelClear/gameOver/paused`.
3. `enterGame` has exactly three branches: adult / pending student / everything-else (active, legacy-no-role, cache-only, default → active+backfill).
4. `backfillRole(uid)` is a distinct `setDoc(users/{uid},{role:'student',status:'active',approvedBy:null},{merge:true})` through the self-update rule branch (1), NOT `saveProfile`.

## Preserved behavior
- `persistProgress` profile literal unchanged; `saveProfile` destructure unchanged (leaderboard write is additive + eligibility-gated).
- Offline/local-only fallback untouched (default/cache object has no `role` → branch 3, no role logic).
- Kid-friendly style retained (Comic Sans MS/Trebuchet MS, pastel, rounded cards, existing `.btn`/`box-shadow`); new `.role-btn`/`.student-row`/`.invite-row`/`.link-code-box` match the existing look.
- `deploy/` folder and `questions.js` not touched.

# Implementation Plan — Phase 1: Three-Role Identity + Cross-Role Authorization

Source of truth: `.agents/design/phase1-roles-and-authorization.md` (APPROVED, iteration 6). This plan sequences that design; it does not re-decide architecture. All paths are absolute under the workspace root `c:\Users\saban\Downloads\RIDHI projects\game 2`.

## Context (verified against the real files)

- Single-file app: `index.html` (~3656 lines). No build step, no framework, no bundler. One inline main-script IIFE + one `<script type="module">` Firebase block.
- There is **no test suite and no build command**. "Verify" below therefore means: load `index.html` in a browser and exercise the path, plus static review of the rules. The Firestore emulator rules test (step 9) is OPTIONAL and runs **only if it can run purely locally** (no login, no network to the live project, no billing); otherwise skip it and flag for the human.
- Branch is already `feature/roles-and-authorization`. Commit **locally only**. Do NOT `git push`/`pull`, open PRs, or run `firebase deploy`/`login` or anything touching live project `mathquest-ca395` or billing.
- Do NOT touch the dead `deploy/` folder, `questions.js`, or the stray `index-Original.html` / `index-Crayon-version.html` files. Edit **only** `index.html` for client changes.
- Nothing here may conflict with later adding Cloud Functions + Vertex AI Gemini (Phase 2).

### Verified anchors in `index.html` (locate by name/id; line numbers approximate)

| Symbol / region | Verified line | Notes |
| --- | --- | --- |
| `#auth` overlay (role picker + new overlays go after it) | 342–367 | `#signupPane` 358–365; `#authMsg` 366; overlay closes 367; `#start` begins 370 |
| module imports (firestore) | 524–526 | currently `getFirestore, doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit, serverTimestamp` |
| `firebaseConfig` literal | 528–537 | `apiKey` at 529 (public — design §6) |
| `auth`/`db` init | 539–546 | `let auth=null, db=null;` try/catch |
| `window.MathQuestCloud` | 570 | object literal start |
| `onAuthChange` | 576 | returns `{uid,name}` — keep thin |
| `signup({userid,email,password})` | 585 | writes `setDoc(unameRef,{uid,email})` at 608; `users` create at 610–616 (`best:0, level:1, grade:1, speed:2`) |
| `loadProfile(uid)` | 641 | |
| `saveProfile(uid, {name,best,...,musicOn})` | 650 | fixed destructure, NO role/status; `setDoc(users/{uid}, {...}, {merge:true})` ends 672 |
| `USERS`/`USERNAMES` consts | 547–548 | add LINKS/LINKCODES/LEADERBOARD beside these |
| `normalizeUserid` / `validUserid` | 551 / 554 | reuse for invite classification |
| `const el = {` map | 701 | auth-area handles run ~724–737 (`start` at 735) |
| `showAuth()` | 1053 | calls `hideAllOverlays()` |
| `const cloud = () => window.MathQuestCloud` | 1061 | main-script accessor |
| `doSignup()` | 1073 | reads `userid`(1074)/`email`(1075 — `.trim()`, NOT lowercased)/`pass`(1076) |
| `enterGame(user)` | 1104 | `loadProfile` 1109, `getCached` 1111, default literal 1112 (`{name,best:0,level:1,grade:1,speed:2}`), existing start path `hideAllOverlays()`+`el.start...show`+`state="start"` at 1155–1157 |
| `logout()` | 1163 | |
| `persistProgress(opts)` | 1194 | profile literal ~1198; debounced save 1188; immediate save 1202 |
| stale leaderboard comment + `submitBestToCloud()` | 1210 / 1211 | comment says "the leaderboard reads from users/{uid}" |
| `levelCleared()` | 1971 | sets `state="levelClear"` internally; calls `submitBestToCloud()` ~1995; function ends ~2004 |
| `gameOver()` | 2005 | sets `state="gameOver"`; calls `submitBestToCloud()` ~2010; function ends ~2028 |
| `renderLeaderboardRows(rows)` | 2029 | reads `name/best/level` — unchanged |
| `showLeaderboard()` | 2045 | pushes best (2050) then queries |
| pause STATE string | 2171 / 2204 | value is `"paused"` (element ids `pause`/`countdown` are NOT states) |
| `hideAllOverlays()` | 2391 | hardcoded array literal at **2392**: `[el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown, el.help, el.scratch, el.leaderboard]` |
| `startAuthListener(tries)` | 3635 | offline branch 3638–3640; `enterGame(user)` wired 3643 |

Verified state enumeration (comment at line 817): `auth | start | playing | battle | levelClear | gameOver | leaderboard`, plus `paused` (2171/2204). **`"pending"` collides with none** of these — safe to use for the waiting screen.

---

# Implementation Plan

- [ ] 1. **Add Firestore collection constants + imports in the module block.**
      In `index.html`, beside `USERS`/`USERNAMES` (~547–548) add `const LINKS="links";`, `const LINKCODES="linkCodes";`, `const LEADERBOARD="leaderboard";`. Extend the firestore import (~524–526) to also import `updateDoc`, `where`, `onSnapshot` from the same `.../10.12.2/firebase-firestore.js` URL. Do NOT import `deleteField`. Add module-scope `let leaderboardEligible = false;` near the `let auth=null, db=null;` state (~539).
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: open `index.html` in a browser; DevTools console shows no module/import error and `window.MathQuestCloud` is defined (leaves app buildable/runnable — no behavior change yet).

- [ ] 2. **Extend `signup(...)` to take a role and provision adult link codes.**
      Change `signup({userid,email,password})` (~585) to `signup({userid,email,password,role})`. Validate `role in {'student','teacher','parent'}` (default/reject invalid to `'student'`). Keep `setDoc(unameRef,{uid,email})` (~608) unchanged (no new field). In the `users` create payload (~610–616): always write `role`; for `role==='student'` write `status:'pending', approvedBy:null` and keep `best:0`; for an adult generate a unique 7-char `linkCode` from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (retry on collision via `getDoc(linkCodes/{code})`), then `setDoc(linkCodes/{code}, {adultUid:uid, role})` and store `linkCode` on the `users` doc. Add a module-scope `let myRole=null, myLinkCode=null;` cache set on successful signup/login so adult-side helpers can read them (or read from the loaded profile — see step 4/6). Keep the create-rule-compatible shape: students must create with `best==0, status=='pending', approvedBy==null`.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: static review — the student create payload still satisfies the §6 create rule (`best==0 && status=='pending' && approvedBy==null`); adult payload includes `role` + `linkCode`. Browser: no console error on load.

- [ ] 3. **Add the new `MathQuestCloud` methods (invite/accept/code/approve/status/leaderboard-eligibility/backfill).**
      Add to the `MathQuestCloud` object (anywhere after `saveProfile`, before leaderboard query) exactly these, per design §7.1. Email normalization is `lower(trim(x))` at every touch point:
      - `setLeaderboardEligible(bool){ leaderboardEligible = !!bool; }`
      - `inviteStudent({identifier})`: classify via `validUserid` vs contains `@`. userid → `getDoc(usernames/{normalizeUserid(id)})`; if missing return `{ok:false,error:"No student with that user ID."}`; else `setDoc(links/{studentUid}_{me}, {studentUid, adultUid:me, adultRole:myRole, source:'invite', targetKind:'userid', targetValue:userid, status:'invited', createdBy:me, createdAt:serverTimestamp(), decidedAt:null})`. email → `key=lower(trim(email))`; `setDoc(links/("email|"+me+"|"+key), {studentUid:null, adultUid:me, adultRole:myRole, source:'invite', targetKind:'email', targetValue:key, status:'invited', createdBy:me, createdAt:serverTimestamp(), decidedAt:null})` (no lookup, no email sent).
      - `listMyStudents()`: `query(links, where('adultUid','==',me), where('status','in',['invited','accepted','requested','approved']))`; for rows with a concrete `studentUid`, `getDoc(users/{studentUid})` for name; email-invite rows without a name show `targetValue`. Return `[{linkId, studentUid, name|email, source, status}]`.
      - `listMyInvites({myEmail})`: caller passes `myEmail` already `lower(trim(...))`. Union of `query(links, where('studentUid','==',me), where('status','in',['invited','requested']))` and `query(links, where('targetKind','==','email'), where('targetValue','==',myEmail), where('status','==','invited'))`. For each, `getDoc(users/{adultUid})` for `adultName`. Return `[{linkId, adultUid, adultName, adultRole, targetKind, status}]`.
      - `acceptInvite({linkId, targetKind, adultUid, adultRole})`: **links write first, then users write.** userid → `updateDoc(links/{linkId}, {status:'accepted', decidedAt:serverTimestamp()})` then `updateDoc(users/{me}, {status:'active', approvedBy:adultUid, updated:serverTimestamp()})`. email → `myEmail=lower(trim(storedEmail))`; `setDoc(links/{me}_{adultUid}, {studentUid:me, adultUid, adultRole:(adultRole ?? null), source:'invite', targetKind:'email', targetValue:myEmail, status:'accepted', createdBy:me, createdAt:serverTimestamp(), decidedAt:serverTimestamp()})` then the same `users` activate. Never write `'?'` for `adultRole` — use the real role or `null`.
      - `requestByCode({code})`: `getDoc(linkCodes/{code.toUpperCase/as-stored})`; unknown → `{ok:false,error:"That code didn't match an adult."}`; else `setDoc(links/{me}_{adultUid}, {studentUid:me, adultUid, adultRole:<code.role>, source:'code', targetKind:null, targetValue:null, status:'requested', createdBy:me, createdAt:serverTimestamp(), decidedAt:null})`.
      - `approveStudent({studentUid})`: `updateDoc(links/{studentUid}_{me}, {status:'approved', decidedAt:serverTimestamp()})` then `updateDoc(users/{studentUid}, {status:'active', approvedBy:me, updated:serverTimestamp()})`.
      - `denyStudent({studentUid})`: `updateDoc(links/{studentUid}_{me}, {status:'denied', decidedAt:serverTimestamp()})` only (no `users` write).
      - `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db, USERS, uid), s => cb(s.data())); }` — takes `uid` as a parameter, returns the unsubscribe or a no-op; NO game logic.
      - `myLinkCode()`: getter returning the adult's own stored `linkCode`.
      - `backfillRole(uid)`: `setDoc(users/{uid}, {role:'student', status:'active', approvedBy:null}, {merge:true})` — a **distinct** write, NOT via `saveProfile`.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: static review of each method against design §7.1 (signatures, field names, link-write-first ordering, email normalization). Browser: no console error on load; `window.MathQuestCloud.setLeaderboardEligible` etc. are callable in DevTools.

- [ ] 4. **Gate the leaderboard write in `saveProfile`; repoint the leaderboard read.**
      In `saveProfile` (~650): keep the unconditional `setDoc(users/{uid}, …)` (ends ~672) exactly as today. After it, add `if (leaderboardEligible === true) await setDoc(doc(db, LEADERBOARD, uid), {name, best, level, updated: serverTimestamp()}, {merge:true});`. Do NOT add `role`/`status` to the destructure. Repoint the leaderboard query (used by `showLeaderboard`/`topScores`): read `query(collection(db, LEADERBOARD), orderBy('best','desc'), limit(max))` instead of `users`. `renderLeaderboardRows` (~2029) stays unchanged.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: browser — with a signed-in active/adult account, playing then opening the leaderboard shows rows (reads `leaderboard`); console shows a `leaderboard/{uid}` write only when eligible. Static: `saveProfile` destructure unchanged; `persistProgress` literal (~1198) unchanged.

- [ ] 5. **Add the role picker to the signup pane + the two new overlays + CSS.**
      In the `#signupPane` (~358–365) add a role picker: three selectable buttons "I'm a Student / Parent / Teacher" (default Student) styled with the existing `.grade-btn`/swatch pastel pattern; track the selection in a module/main-script variable read by `doSignup`. After the `#auth` overlay closes (after line 367, before `#start` at 370) add two sibling `<div class="overlay">` blocks:
      - `#pendingApproval`: explanation text; an invite-list container `#inviteList`; a fallback "Have a code? Enter it" input `#codeInput` + Send button; a "Play solo for now" button.
      - `#approvalDesk`: an "Invite a student" input `#inviteInput` (placeholder "user ID or email") + Send button; a student-list container `#studentList`; a display of the adult's own `linkCode`; an "Open game" button.
      Add a small CSS block in the `/* Auth */` region (~151–171) for `.role-btn`, `.student-row`, `.invite-row` matching the existing kid-friendly style (`"Comic Sans MS"`/`"Trebuchet MS"`, pastel, rounded cards, existing `box-shadow`/button look). Reuse `.overlay`, `.btn`, `.btn.big`, `.auth-hint`, `.grade-btn`.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: browser — Sign Up tab shows the role picker; temporarily force-show `#pendingApproval` and `#approvalDesk` via DevTools (`document.getElementById('pendingApproval').classList.add('show')`) to confirm layout/styling matches the existing overlays.

- [ ] 6. **Register the new overlays in the `el` map AND the `hideAllOverlays()` array (the HIGH finding).**
      In the `el = {` map (~701, among the auth-area handles ~724–737) add `pendingApproval: document.getElementById("pendingApproval"),` and `approvalDesk: document.getElementById("approvalDesk"),`. In `hideAllOverlays()` add both to the hardcoded array at line **2392** so it becomes:
      `[el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown, el.help, el.scratch, el.leaderboard, el.pendingApproval, el.approvalDesk].forEach(o => o.classList.remove("show"));`
      This is mandatory — `hideAllOverlays` sweeps a hardcoded list, not `.overlay.show`; without it the new overlays stick on screen. Do NOT refactor to `querySelectorAll`.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: browser — show `#pendingApproval`, then trigger a flow that calls `hideAllOverlays()` (e.g. `showAuth()` via logout); confirm it disappears. Confirm `el.pendingApproval`/`el.approvalDesk` are non-null in DevTools. (Depends on step 5.)

- [ ] 7. **Wire the auth-flow handlers: three-branch `enterGame`, pending/adult screens, live transition, legacy backfill.**
      In the main IIFE, declare together `let unsubMyStatus = null; let justActivated = false;` (near other auth state). Edits:
      - `doSignup()` (~1073): read the selected role; call `cloud().signup({userid,email,password:pass,role})`.
      - `enterGame()` (~1104): after `loadProfile`/`getCached`/default (1109–1112), branch into exactly three cases:
        1. **adult** (`profile.role==='teacher'||profile.role==='parent'`) → `cloud().setLeaderboardEligible(true)`, `showApprovalDesk()` (render `#approvalDesk`).
        2. **pending student** (`profile.role==='student' && profile.status==='pending'`) → `cloud().setLeaderboardEligible(false)`, `showPending()` (render `#pendingApproval`), `state="pending"`, wire Accept/code/solo handlers, `unsubMyStatus = cloud().watchMyStatus(currentUid, onMyStatus)`.
        3. **everything else** (active student, legacy no-`role`, cache-only, default literal) → `cloud().setLeaderboardEligible(true)`, run the existing start-screen path (`hideAllOverlays()`+`el.start.classList.add("show")`+`state="start"`, currently at 1155–1157), and if `profile.role` is missing call `cloud().backfillRole(currentUid)`.
        Keep the offline/local-only path untouched: when `cloud()` is unavailable the default/cache object has no `role` and MUST land in branch 3 (no role logic). The default literal and cached object carry no `role`, so they fall into branch 3 by construction.
      - Add handlers: `showPending()`, `showApprovalDesk()`, `renderMyInvites()` (builds `#inviteList` rows from `listMyInvites({myEmail:lower(trim(storedEmail))})`; `invited` rows render Accept, own `requested` rows render "waiting for approval"), `renderMyStudents()` (builds `#studentList` from `listMyStudents()`; invites show "sent"/"accepted", code-requests show Approve/Deny), `onAcceptInvite(linkId,targetKind,adultUid,adultRole)` → `cloud().acceptInvite(...)`, `onRequestByCode()` → `cloud().requestByCode({code})`, `onInviteStudent()` → `cloud().inviteStudent({identifier})`, `onApprove(uid)`/`onDeny(uid)`, `playSolo()` (hide pending, run normal start path), and `onMyStatus(data)`.
      - `onMyStatus(data)`: when `data.status==='active'`: if `state!=='playing'` → `cloud().setLeaderboardEligible(true)`, `hideAllOverlays()`, `el.start.classList.add("show")`, `state='start'`, then `unsubMyStatus?.(); unsubMyStatus=null;`. If `state==='playing'` → `cloud().setLeaderboardEligible(true)`, `justActivated=true` (do not interrupt; keep subscribed).
      - Deferred transition: append this 3-line block to the **end of `gameOver()` (~2005, before line 2028) and `levelCleared()` (~1971, before line 2004)** — NOT to any `levelClear` id/handle:
        `if (justActivated) { justActivated=false; hideAllOverlays(); el.start.classList.add("show"); state="start"; unsubMyStatus?.(); unsubMyStatus=null; }`
      - Wire the new overlays' buttons (`#inviteInput` Send, `#codeInput` Send, Play-solo, Open-game, per-row Accept/Approve/Deny) to the handlers near the existing button wiring (~2307–2313).
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: browser manual trace — (a) sign up as teacher → lands on `#approvalDesk` with a visible link code; (b) sign up as student → lands on `#pendingApproval` (`state==='pending'`), can Play solo; (c) teacher invites the student by userid → student's `#inviteList` shows Accept → accepting flips the student to the start screen live; (d) mid-game activation defers to the next game-over/level-clear. Console shows no errors. (Depends on steps 3,5,6.)

- [ ] 8. **Clean up logout, the stale comment, and finalize live-transition teardown.**
      In `logout()` (~1163) add `unsubMyStatus?.(); unsubMyStatus=null;` and `cloud().setLeaderboardEligible(false);` so the snapshot detaches and the flag never leaks across sessions. Update the stale comment above `submitBestToCloud` (~1210) to reference `leaderboard/{uid}` (e.g. "...the leaderboard reads from `leaderboard/{uid}`, which `saveProfile` writes alongside `users/{uid}`"). Leave `submitBestToCloud` (1211), `persistProgress` (1194) and its profile literal (~1198) otherwise unchanged.
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\index.html`
      Verify: browser — log out from a pending-student session; confirm (DevTools) the `onSnapshot` listener is gone (no further `watchMyStatus` callbacks) and a subsequent offline/local play writes no `leaderboard` row. (Depends on step 7.)

- [ ] 9. **Author `firestore.rules`, `firestore.indexes.json`, and `firebase.json` at the repo root.**
      Create `c:\Users\saban\Downloads\RIDHI projects\game 2\firestore.rules` exactly per design §6: the ATTACK-CASE INDEX comment block (A1–A9 + N1–N6) atop the file, `rules_version='2'`, helpers (`signedIn`, `isSelf`, `incoming`, `existing`, `callerRoleIs`, `callerEmail` returning `.lower()`, `adultLinkedTo`, `approvedLinkExists`, `acceptableInviteExists`, `emailInviteToMe`, `onlyStatusAndApprover`), and the `usernames`/`linkCodes`/`leaderboard`/`users`/`links` match blocks with all branches (users 1/2/3; links a/b/c/c2/d/e) as written in §6. Create `firestore.indexes.json` with three `links` composite indexes: `(adultUid asc, status asc)`, `(studentUid asc, status asc)`, `(targetKind asc, targetValue asc, status asc)`. Create a minimal `firebase.json` pointing `firestore.rules` + `firestore.indexes.json` (no hosting change — GitHub Pages stays the host). **Author as files only; do NOT run `firebase deploy`/`login`.**
      Files: `c:\Users\saban\Downloads\RIDHI projects\game 2\firestore.rules`, `c:\Users\saban\Downloads\RIDHI projects\game 2\firestore.indexes.json`, `c:\Users\saban\Downloads\RIDHI projects\game 2\firebase.json`
      Verify: static review — every attack case A1–A9 + N1–N6 maps to a rule branch (trace in the Verification section below); `firestore.indexes.json` is valid JSON with the three indexes; `firebase.json` is valid JSON referencing the two files. OPTIONAL emulator test only if it can run purely locally (no login/network/billing) — see step 10; otherwise skip and note it.

- [ ] 10. **(OPTIONAL, local-only) Firestore emulator rules test — else skip and flag.**
      Only if a purely local emulator is available with NO login, NO network to the live project, and NO billing: add `test/firestore.rules.test.js` using `@firebase/rules-unit-testing` covering A1–A9 + N1–N6 (per design §9), and run it against the emulator. If any of those preconditions cannot be met, **do not attempt it** — skip this step and record in the commit message / final report that emulator rules testing was deferred to the human (the rules + indexes are committed but untested against the live project this phase, per design §11 "Composite indexes untested this phase").
      Files: (optional) `c:\Users\saban\Downloads\RIDHI projects\game 2\test\firestore.rules.test.js`
      Verify: if run, all A*/N* assertions pass against the local emulator. If skipped, the final report explicitly states rules/indexes are committed-but-untested and flags emulator testing for the human.

- [ ] 11. **Commit locally on `feature/roles-and-authorization`.**
      Stage only the touched files by name (`index.html`, `firestore.rules`, `firestore.indexes.json`, `firebase.json`, and the optional test if created) and commit locally with a clear message. Do NOT `git push`/`pull`, open a PR, or amend. Do NOT stage the stray `index-Original.html` / `index-Crayon-version.html` or the `.agents/design/*` doc changes unless they are part of this task's intended output.
      Files: (git only)
      Verify: `git log --oneline -1` shows the new local commit on `feature/roles-and-authorization`; `git status` shows a clean tree for the intended files; `git branch --show-current` is `feature/roles-and-authorization`. No remote interaction occurred.

---

# Verification Section

## A. `firestore.rules` traced against every documented attack case (both flows)

Trace each case to the branch that blocks it (matches the comment block atop the rules file):

- **A1 (student self-approves via users self-update):** `users` update branch (1) asserts `incoming().status == existing().status` → status cannot change on the self path. The only student status change is branch (2), gated by `acceptableInviteExists` which needs a real adult-authored link (impossible to self-author per N1/N4). Blocked.
- **A2 (self-link chain: fake linkCodes teacher → self link → self-approve):** `linkCodes.create` requires `callerRoleIs([incoming().role])` (a student's own `users.role` is `student`); `links` branch (b) requires `studentUid != adultUid` AND target `users.role in ['teacher','parent']`; `users` branch (3) requires `request.auth.uid != uid` AND `callerRoleIs(['teacher','parent'])`. Three independent gates. Blocked.
- **A3 (`studentUid == adultUid`):** branch (a) `adultUid != studentUid`; branch (b) `studentUid != adultUid`. Blocked.
- **A4 (cross-user `users` read):** `users` read = `isSelf(uid) || adultLinkedTo(uid)`. A student is never the adult in a link to another student. Cross-player scores only via world-readable `leaderboard` (no PII). Blocked.
- **A5 (fabricated score at create):** student `create` forces `status=='pending' && best==0 && approvedBy==null`. Blocked.
- **A6 (role escalation):** branches (1)(2)(3) each assert `incoming().role == existing().role`. Immutable. Blocked.
- **A7 (pending student writes leaderboard):** `leaderboard` create/update requires the writer's own `users` to be non-student OR `status=='active'`, and `keys().hasOnly(['name','best','level','updated'])`. Pending student denied. Blocked.
- **A8 (adult overwrites profile under cover of approval):** `onlyStatusAndApprover(uid)` limits both branch (2) and (3) diffs to `status`/`approvedBy`/`updated`. Blocked.
- **A9 (adult approves with no approved link):** branch (3) requires `approvedLinkExists` (`exists()`-guarded, status `=='approved'`); an adult can only set `approved` on a link whose `adultUid` is themselves (branch (d)). Blocked.
- **N1 (student forges invite from a fake adult):** `links` branch (a) requires `isSelf(adultUid) && callerRoleIs(['teacher','parent'])`; a student is neither → cannot author an `invited` link → `acceptableInviteExists`/`emailInviteToMe` find nothing. Blocked.
- **N2 (student escalates via the accept write):** branch (2) `onlyStatusAndApprover` + `role` immutable + `status` forced `active` + `approvedBy` must be the inviting adult confirmed by `acceptableInviteExists`. Activation only. Blocked.
- **N3 (student accepts an invite naming a different student):** userid → branch (c) requires `existing().studentUid == request.auth.uid`, and branch (2) `acceptableInviteExists` re-checks; email → branch (c2) + `emailInviteToMe` reconstruct the id from `callerEmail()` and require `targetValue == callerEmail()`. Blocked.
- **N4 (non-adult sends invites):** branch (a) `callerRoleIs(['teacher','parent'])`. Blocked.
- **N5 (adult forges invite from another adult):** branch (a) `isSelf(incoming().adultUid)`; email id must be `'email|'+request.auth.uid+'|'+targetValue`; userid id must be `studentUid+'_'+adultUid` with `adultUid==self`. Blocked.
- **N6 (student flips another student's invited link):** branch (c) requires `existing().studentUid == request.auth.uid` and `incoming().studentUid == request.auth.uid`; email path (c2) keyed on caller's own uid guarded by `emailInviteToMe`. Blocked.
- **Email case-normalization feasibility (§3.1.1):** `callerEmail()` returns `.lower()`; invite id/`targetValue` stored lowercased (branch (a) asserts `targetValue == targetValue.lower()`); client `listMyInvites` passes `lower(trim(storedEmail))`. All four touch points agree → PRIMARY email path is reachable and fails closed if mismatched.

## B. `index.html` auth-state routing traced for every role/state

Entry points: `startAuthListener` (~3635) → offline branch (3638–3640, shows auth, no role logic) or `onAuthChange` → `enterGame(user)` (~1104). `enterGame` loads profile (1109→getCached 1111→default 1112) then the three-branch switch (step 7):

- **Offline (Firebase unavailable):** `startAuthListener` offline branch shows the auth screen; if a local session exists, `enterGame`'s `cloud()` is unavailable so profile = cache/default with no `role` → **branch 3** → normal start screen, `getCached` path, zero role logic. No regression.
- **Signed-out:** `showAuth()` (~1053) → `hideAllOverlays()` (now sweeps the two new overlays too) → `#auth` shown, `state='auth'`.
- **Active student:** profile `role==='student', status==='active'` → **branch 3** → start screen, `setLeaderboardEligible(true)`.
- **Pending student:** `role==='student', status==='pending'` → **branch 2** → `#pendingApproval`, `state='pending'`, `setLeaderboardEligible(false)`, `watchMyStatus(currentUid,onMyStatus)` wired; Accept/code/solo handlers active; live `pending→active` via `onMyStatus` (immediate if `state!=='playing'`, deferred via `justActivated` at `gameOver()`/`levelCleared()` otherwise).
- **Teacher / Parent:** `role in {teacher,parent}` → **branch 1** → `#approvalDesk` with invite input, student list, own link code; `setLeaderboardEligible(true)`.
- **Legacy (no `role`) / cache-only / default literal:** no `role` field → **branch 3** → start screen + `backfillRole(currentUid)` (distinct merge write via rule branch (1); `best` untouched).

## C. New overlays are correctly hidden (HIGH finding)

Confirmed anchors: `hideAllOverlays()` at 2391, its hardcoded array at 2392 (step 6 appends `el.pendingApproval, el.approvalDesk`); `el` map at 701 (step 6 adds both handles). `showAuth()` (1053) and `enterGame` branch 3 both call `hideAllOverlays()`, so the new overlays are cleared on every auth/start transition. Without both edits the overlays stick — this is the previously-identified HIGH finding and is mandatory.

## D. Testing / build status (explicit)

- There is **no build step and no automated test suite** in this repo. Primary verification is manual browser exercise of each flow (steps 1–8) plus static review of the rules (step 9, section A above).
- The Firestore emulator rules test (step 10) is run **only if purely local** (no login, no network to the live project, no billing). Otherwise it is **skipped and flagged for the human**, and `firestore.rules` + `firestore.indexes.json` ship committed-but-untested against the live project this phase (design §11).
- No `firebase deploy`/`login`, no `git push`/`pull`/PR. Commit is local-only on `feature/roles-and-authorization`.

## E. Assumptions / gaps noted

- `myRole`/`myLinkCode` are cached in the main script from the loaded profile (or signup result) so adult-side helpers can stamp `adultRole`/show the code without an extra read; if the implementer prefers reading them straight off the loaded `profile` in `enterGame`, that is equivalent — pick one and keep it consistent.
- The fallback `linkCodes` lookup key case: codes are generated uppercase; `requestByCode` should look up by the code as entered normalized to uppercase to match the stored id.
- Rate-limiting of invites/code-requests is intentionally out of scope (needs a Cloud Function — Phase 2), per design §6/§10.

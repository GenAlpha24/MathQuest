# Design Review — Phase 1 MathQuest: Three-Role Identity + Bidirectional Linking

Reviewed document: `.agents/design/phase1-roles-and-authorization.md` (Status: REVISED, iteration 6).
Scope of this review (per the step brief): the CHANGED linking/authorization mechanism (bidirectional invite + code fallback) and its security, plus a narrow spot-check of the `index.html` edit anchors and the four carried-forward residual findings. Settled parts (roles, extended users model, denormalized leaderboard, offline fallback, role immutability, live pending→active transition) were NOT re-litigated.

Verdict: **APPROVED** — 0 HIGH, 0 MEDIUM. Three NITs noted below; none block.

---

## Verified Assumptions (checked against source)

1. **Signup stores email verbatim (trimmed, not lowercased).** Verified. `doSignup` does `const email = el.signupEmail.value.trim();` (~1074); `signup(...)` writes `setDoc(unameRef, { uid, email })` (~606) and the `users` doc with `email` raw (~608–613). No `.toLowerCase()` anywhere on the path. This confirms the premise of §3.1.1 — the email-invite case-normalization fix is addressing a real mismatch, and the design's cited anchors (~1075 trim, ~608/~612 writes) are accurate within "locate by name" tolerance.
2. **`saveProfile` destructure carries no `role`/`status`.** Verified. Signature is `saveProfile(uid, { name, best, level, grade, speed, heroColor, hairColor, eyeColor, heroHair, heroGender, gemMatchColor, megaGemsCollected, ultraGemsCollected, subject, musicOn })` (~654). The design's claim that `saveProfile` cannot see role/status (hence the `setLeaderboardEligible` flag and the distinct `backfillRole`) is correct. Anchor ~659 is within tolerance (actual ~654).
3. **`enterGame` default + cache objects carry no `role`.** Verified. Default literal is `{ name: currentUser, best: 0, level: 1, grade: 1, speed: 2 }` (~1109) and the cache object (`cacheProfile`) has no `role`. Both correctly fall into the design's third ("everything else") branch, confirming the three-way-branch reasoning and the legacy-backfill trigger. `enterGame` anchor ~1104 is exact; it currently has no role branching, so the insertion is net-new.
4. **`hideAllOverlays` sweeps a hardcoded array, not `.overlay.show`.** Verified (~2391): `[el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown, el.help, el.scratch, el.leaderboard].forEach(o => o.classList.remove("show"));`. The design's requirement to add `el.pendingApproval, el.approvalDesk` to both the `el` map and this array is correct and necessary, and the exact snippet it provides matches. Anchor ~2390/~2392 accurate (actual ~2391).
5. **State-string set.** Verified. `state` is assigned `"auth"`, `"start"`, `"playing"`, `"battle"`, `"levelClear"`, `"gameOver"`, `"paused"`. The pause string is `"paused"` (~2171, ~2204). There is NO `"pause"`/`"countdown"` state — `pause`/`countdown` appear only as element ids/`el` handles. The design's verified set and the uniqueness of the new `"pending"` string are correct.
6. **`levelCleared()` vs `levelClear`.** Verified. The level-clear handler is `function levelCleared()` (~1971), which sets `state = "levelClear"` internally. There is no `function levelClear()`. The design hooks `levelCleared()` and explicitly leaves the `levelClear` id/handle/state alone — correct.
7. **`gameOver()` anchor.** Verified at ~2006 (design says ~2005 — within tolerance).
8. **`submitBestToCloud()` → `persistProgress({immediate:true})` → `saveProfile`, and its three call sites.** Verified. `submitBestToCloud` (~1211) calls `persistProgress({ immediate: true })`; it is called from `levelCleared()` (~1995), `gameOver()` (~2010), and `showLeaderboard()` (~2050). Confirms §7.6's "no new write call site" claim and the "`saveProfile` is the only leaderboard writer" invariant.
9. **The stale leaderboard comment is real.** Verified (~1210): `// ... saving the profile also updates the global board, // since the leaderboard reads from users/{uid}.` The design correctly flags this for a comment-only update to reference `leaderboard/{uid}`.
10. **Current Firestore imports omit `updateDoc`/`where`/`onSnapshot`.** Verified (~524–527): imports are `doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit, serverTimestamp`. The three additions the design requires are genuinely absent and `deleteField` is correctly not imported.
11. **`currentUid`, `el` map, `USERS`/`USERNAMES`, `firebaseConfig`/`apiKey` anchors.** Verified: `currentUid` at ~774 (design ~775), `el` map at ~701 (exact), `USERS`/`USERNAMES` constants at ~547–548 (design ~565 — off ~18 lines but locatable by name), `firebaseConfig` ~528 / `apiKey` ~529 (design ~527–537/~528). All within the stated "locate by name" tolerance.
12. **`usernames/{userid}` already carries `{uid, email}`.** Verified: `setDoc(unameRef, { uid: cred.user.uid, email })`. The design's reuse of this as the userid→uid invite resolver without a shape change is sound; no `role` field is added.

## Unverified / Wrong Assumptions

None material. Firestore-rules-language behavior (`.lower()` on a `get(...).data.email` string, `diff().affectedKeys().hasOnly(...)`, `exists()`/`get()` on reconstructed paths, `in` membership) is relied on but cannot be executed in this review step (no emulator run is in scope, and the design itself flags composite indexes and rules as committed-but-undeployed). These are standard rules-v2 constructs and the design already lists emulator unit tests (§9) as the verification vehicle; this is a known, documented limitation rather than a wrong assumption.

---

## Security walk-through of the CHANGED linking flow (no blocking findings)

The new attack cases were each traced to a hard deny; the reasoning holds against source.

- **Student forges an invite "from" a fake adult to self-activate (N1/N4).** To get an `invited` link the student must pass `links` branch (a): `isSelf(incoming().adultUid) && callerRoleIs(['teacher','parent'])`. A student's own `users.role == 'student'`, so `callerRoleIs` fails; they cannot author an `invited` link naming themselves as the adult. With no adult-authored link, the `users` accept branch (2)'s `acceptableInviteExists` (userid) / `emailInviteToMe` (email) find nothing. **Blocked.**
- **Student escalates via the accept write (N2).** Branch (2) is diff-limited by `onlyStatusAndApprover` to `status`/`approvedBy`/`updated`, forces `status == 'active'`, and keeps `role == existing().role`. `approvedBy` is attacker-controlled input, but `acceptableInviteExists(uid, incoming().approvedBy)` requires a real `invited`/`accepted` link at `links/{uid}_{approvedBy}` — only an adult can create it (branch a). So the student can only ride an accept to `active`; no role bump, no score change, no arbitrary approver. **Blocked.**
- **Accepting an invite that names a different student (N3/N6).** Userid path: branch (c) requires `existing().studentUid == request.auth.uid` and branch (2) independently re-checks via `acceptableInviteExists` (which asserts `get(path).data.studentUid == studentUid`, with `studentUid == auth.uid`). Email path: branch (c2) creates `links/{auth.uid}_{adultUid}` guarded by `emailInviteToMe`, which reconstructs the invite id from `callerEmail()` (the caller's OWN stored email) and requires `targetValue == callerEmail()`. A student cannot prove an invite addressed to someone else's email/uid. **Blocked.**
- **Non-adult sends invites (N4).** Branch (a) `callerRoleIs(['teacher','parent'])` denies any non-adult creating an `invited` link. **Blocked.**
- **Adult forges an invite "from" another adult (N5).** Branch (a) requires `isSelf(incoming().adultUid)`; userid id must be `studentUid_adultUid` with `adultUid == self`, and the email id must be `'email|' + request.auth.uid + '|' + targetValue`. An adult cannot name a different `adultUid`. **Blocked.**
- **Carried-forward cases (A1–A9).** Student self-approve via self-update (branch (1) pins `status`/`approvedBy` unchanged); self-link chain (three independent gates: `linkCodes` create `callerRoleIs`, `links` (b) `studentUid != adultUid` + target role check, `users` (3) `auth.uid != uid` + `callerRoleIs`); `studentUid == adultUid` self-link (inequality in (a) and (b)); cross-user `users` read (read = `isSelf || adultLinkedTo`); fabricated score at create (student `create` forces `best == 0 && status == 'pending' && approvedBy == null`); role immutability (every update branch asserts `role == existing().role`); pending student leaderboard write (leaderboard write requires non-student or `status == 'active'`). All trace to deny. **Blocked.**
- **role immutability & create constraints.** Verified in-rule: `create` pins `role in {...}` and, for students, `status == 'pending' && best == 0 && approvedBy == null`; backfill goes through the self-`update` branch (1) which does not re-assert `best == 0`, so it does not disturb an existing score. Consistent with §4.1/§7.4 and the real `saveProfile` shape.
- **Pending student cannot self-activate or write leaderboard rows across either flow.** Self-activation requires an adult-authored link (invite path) or an adult approver write (code path); neither is forgeable by the pending student. Leaderboard write is doubly guarded (rule `status=='active'` + client `leaderboardEligible=false` for pending). **Holds.**
- **Offline / active-user flow untouched.** `enterGame`'s role branching is net-new and gated on the online profile; the offline path (`getCached` + local leaderboard) and the existing start-screen/game loop are not altered by the design. Verified that current `enterGame` already funnels default/cache objects (no `role`) into the active path, so the "everything else" branch preserves today's behavior. **No regression.**
- **Email case-normalization (the iteration-6 change).** The single-point `lower(trim(...))` normalization across the four touch points (stored `targetValue`, invite id, `callerEmail()` rule read, discovery query) is internally consistent, and the premise (verbatim-case signup email) is verified in source. The prior mismatch failed closed (no privilege hole), so this is a feasibility repair, correctly scoped.

---

## Findings

1. **NIT — `adultLinkedTo` cannot authorize the adult's read of an un-accepted email invitee, which the UI implies it needs.** §4.6 ("Adult shows each linked student's name/status: `getDoc(users/{studentUid})` — allowed because a link exists") and §7.1 `listMyStudents` say rows without a name (un-accepted email invite) "display `targetValue` (the email) and state 'sent'." That is internally consistent (the adult shows the typed email, not a `users` read) and `adultLinkedTo` deliberately covers only the deterministic `studentUid_adultUid` id. No contradiction in behavior. The NIT is purely that the §4.6 bullet's phrasing ("allowed because a link exists") reads as if it applies to all rows; add a half-sentence clarifying it applies only to rows with a concrete `studentUid` (userid invites, code-requests, accepted email invites), matching the helper comment already in §6. Non-blocking: the rules and the `listMyStudents` spec are already correct.

2. **NIT — stale pre-change line anchors drift ~15–18 lines in two spots.** `saveProfile` is at ~654 (design ~659) and the `USERS`/`USERNAMES` constants at ~547–548 (design ~565). Both are still trivially locatable by name and the document repeatedly instructs "locate by function name / element id, not line number," so this does not block. Tighten the two anchors on the next edit if convenient.

3. **NIT — `approvedLinkExists` / `acceptableInviteExists` use `let path = ...` inside a function while other helpers inline the path.** Stylistic only; rules-v2 supports `let` bindings in functions, and the design uses both forms. No correctness impact. Optionally make the style uniform.

---

## Carried-forward residual findings — correctly applied

- **`watchMyStatus(uid, cb)` takes `uid` as a param.** Applied correctly (§7.1/§5): `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db,USERS,uid), s=>cb(s.data())); }`, wired `cloud().watchMyStatus(currentUid, onMyStatus)`. `currentUid` confirmed as the main-script var (~774). Safe no-op unsubscribe returned when db/uid missing. Correct.
- **Verified state-string set.** Applied; matches source exactly (see Verified Assumption 5). `"pending"` is unique. Correct.
- **`enterGame` three-branch coverage.** Applied; the default literal and cache object (verified to lack `role`) land in the third branch with legacy backfill. Correct.
- **Distinct `backfillRole` write.** Applied: `setDoc(users/{uid}, {role:'student',status:'active',approvedBy:null}, {merge:true})` through the self-`update` branch, explicitly NOT `saveProfile` (whose fixed destructure — verified — would drop the three fields). Correct.

All four are correctly carried forward and specified.

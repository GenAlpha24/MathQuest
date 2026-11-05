# Design Review — Phase 1: Three-Role Identity + Cross-Role Authorization

Reviewed document: `.agents/design/phase1-roles-and-authorization.md` (iteration 4)
Reviewed against source: `index.html` (3656 lines), `questions.js`
Review scope: design-only; no build/test run (there is none).

Verdict: **CHANGES_REQUESTED** (1 MEDIUM, 0 HIGH, 3 NITs)

The security-rules strategy is sound and I could not find a privilege-escalation hole: the self-approval chain is genuinely closed at three independent gates, `role` is immutable on both update branches, students are forced to `status:'pending' && best==0 && approvedBy==null` at create, cross-user `users` reads are denied, and the leaderboard regression is fixed by a world-readable denormalized collection with an active-only self-write guard. The client-edit anchors are unusually accurate against the real source. The one blocker is a concrete feasibility gap in a specified function signature (`watchMyStatus`) that references a `uid` that does not exist in module scope.

---

## Findings

### 1. MEDIUM — `watchMyStatus(cb)` references a `uid` that does not exist in module scope
Location: design §7.1 (`watchMyStatus` bullet), §5 (ownership split), §7.3 (`enterGame` wires `unsubMyStatus = cloud().watchMyStatus(onMyStatus)`).

The design specifies `watchMyStatus(cb)` as a thin module wrapper doing `onSnapshot(doc(db, USERS, uid), s => cb(s.data()))`. I verified the Firebase module block (`index.html` ~lines 516–688): every existing method that needs the player's id takes it **as a parameter** (`loadProfile(uid)` ~line 640, `saveProfile(uid, {...})` ~line 648). The module does **not** keep a current-uid variable — `currentUid` is a main-script variable (declared `let currentUid = null;` at line 775, inside the main IIFE) and is not reachable from the module. So the bare `uid` in `watchMyStatus`'s body resolves to nothing; the snapshot cannot be created as written.

By contrast the `saveProfile` leaderboard-write (§7.1) is fine — `saveProfile(uid, …)` already receives `uid`, so `setDoc(leaderboard/{uid}, …)` has it in scope. The problem is isolated to `watchMyStatus`.

Concrete fix — pick one and specify it:
- (a) Thread the id through, matching the existing param convention:
  ```js
  // module method
  watchMyStatus(uid, cb) { return onSnapshot(doc(db, USERS, uid), s => cb(s.data())); },
  ```
  and in `enterGame` (which already has `user.uid`): `unsubMyStatus = cloud().watchMyStatus(currentUid, onMyStatus);`
- (b) Read it from Auth inside the wrapper:
  ```js
  watchMyStatus(cb) {
    const u = auth && auth.currentUser;
    if (!u) return () => {};
    return onSnapshot(doc(db, USERS, u.uid), s => cb(s.data()));
  },
  ```
Also specify the no-op unsubscribe when `auth`/`db` is missing (offline), so `unsubMyStatus?.()` in `logout()`/the deferred hook is always safe to call. Option (a) is more consistent with the file's existing `(uid, …)` pattern.

### 2. NIT — §5 enumeration of existing `state` strings is inaccurate (`"pause"`, `"countdown"`)
Location: design §5 and §13 finding 3, which list the existing state-switched values as `"auth"`, `"start"`, `"playing"`, `"levelClear"`, `"gameOver"`, `"pause"`, `"countdown"`.

Verified in source: the pause state string is actually `state = "paused"` (lines 2171 and 2204), **not** `"pause"`; and there is no `state = "countdown"` anywhere. `pause`/`countdown` exist only as element ids / `el.pause` / `el.countdown` handles (el map ~lines 741–742). The real state strings in use are `auth`, `start`, `playing`, `battle`, `levelClear`, `gameOver`, `paused` (the `let state` comment at line 817 lists `auth | start | playing | battle | levelClear | gameOver | leaderboard`).

This does not affect correctness — the new `state = "pending"` value is unique against every actual state string, so the design's core claim (no collision; `state !== 'playing'` test is unambiguous) still holds. But the enumeration should be corrected so the implementer does not test against a non-existent `"pause"`/`"countdown"` state. Fix: replace the list with the verified set above (note `"paused"` and `"battle"`, drop `"countdown"`).

### 3. NIT — `enterGame` must guard the role branch for the null/cache-only profile case
Location: design §7.3 (`enterGame` branches on `role`/`status` "from the already-loaded profile") and §7.4 (legacy backfill when "a loaded profile has no `role`").

Verified: `enterGame` (line 1105) builds `profile` from `cloud().loadProfile` → `getCached` → a hardcoded default literal `{ name, best:0, level:1, grade:1, speed:2 }` (lines 1109–1111). The default and the cached object both have **no `role`**, exactly like a legacy doc. The design's §7.4 rule ("no `role` → treat as student/active + backfill") does cover these, but §7.3's branch text reads as if a `role`/`status` is always present. Make §7.3 explicit that the three branches are: (adult) `role in {teacher,parent}`; (pending student) `role=='student' && status=='pending'`; (everything else incl. missing `role`, cached-only, and default) → active/legacy path + backfill. This removes the ambiguity about which branch a brand-new online profile with a null `loadProfile` result lands in. (Low impact: §7.4 already implies the right outcome; this is a precision/wording fix.)

### 4. NIT — legacy backfill via `saveProfile` cannot write `role`/`status`/`approvedBy`
Location: design §7.4 ("write the backfill (`role:'student', status:'active', approvedBy:null`) via the existing `saveProfile`/`setDoc merge` path").

Verified: `saveProfile(uid, {…})` destructures a **fixed** field list (line 648) and writes only those fields; it has no `role`/`status`/`approvedBy` parameter and the design elsewhere (§4.5, §7.1) deliberately forbids adding them to `saveProfile`'s signature to keep the `users` write shape stable. So "backfill via the existing `saveProfile`" is self-contradictory — `saveProfile` would silently drop the three new fields and never actually backfill them. The design must name a distinct write for the backfill (e.g. a new `MathQuestCloud.backfillRole(uid)` doing `setDoc(users/{uid}, {role:'student', status:'active', approvedBy:null}, {merge:true})`, which goes through the self-`update` rule branch and so is not subject to the create-rule `best==0` constraint — consistent with §4.1). This is a NIT, not a blocker, because the intent and the rule path are already correct in §4.1/§7.4; only the write mechanism is misnamed.

---

## Verified Assumptions (checked against source)

- **Single-file static app, Firebase v10.12.2 from gstatic CDN as ES modules, `window.MathQuestCloud` exposed.** Confirmed: `<script type="module">` at line 516, imports from `.../10.12.2/firebase-{app,auth,firestore}.js`, `window.MathQuestCloud = {…}` ~line 575.
- **`firebaseConfig` + public `apiKey` live in the file (~527–537; `apiKey` ~528), project `mathquest-ca395`.** Confirmed exactly (apiKey at line 528, projectId `mathquest-ca395` at line 531). The "rules are the only protection" premise is correct.
- **Two existing collections `users/{uid}` and `usernames/{userid}`; `usernames` shape is `{uid,email}`.** Confirmed: constants at ~line 549; `setDoc(usernames, {uid, email})` at line 608; `setDoc(users/{uid}, {uid,name,email,best,level,grade,speed,created,updated})` at line 609.
- **`saveProfile(uid, {name,best,level,…,musicOn})` has NO `role`/`status` in scope.** Confirmed at line 648 — the destructured list matches the design's §4.5 claim; the `leaderboardEligible`-flag workaround is justified.
- **`saveProfile` does `setDoc(users/{uid}, …, {merge:true})` unconditionally.** Confirmed (lines 648–668). Adding a conditional `setDoc(leaderboard/{uid}, …, {merge:true})` after it is feasible.
- **`topScores` currently queries `users` with `orderBy("best","desc")`.** Confirmed at line 672. This is the exact read the new restrictive `users` rule would break — the denormalized `leaderboard` collection correctly resolves it, and `renderLeaderboardRows` (line 2029) already renders only `name/best/level`, which the `leaderboard` docs carry.
- **`onAuthChange` callback shape is `{uid, name}`.** Confirmed at line 579. The "keep the listener thin, branch in `enterGame`" decision is implementable with no extra read.
- **`enterGame(user)` is only invoked when `c.available` is true.** Confirmed: `startAuthListener` (line 3633) returns early with an offline message when `!c.available`, and only calls `enterGame(user)` inside the `onAuthChange` success path (lines 3640–3643). So role/status logic never runs offline — the "no offline regression" claim holds. The offline fallback uses `getCached(uid)` inside `enterGame` and the local leaderboard; nothing in the proposed edits touches those paths.
- **`submitBestToCloud()` → `persistProgress({immediate:true})` → `cloud().saveProfile(currentUid, profile)`; called from `levelCleared()`, `gameOver()`, `showLeaderboard()`.** Confirmed: `submitBestToCloud` line 1211; `persistProgress` immediate branch returns `cloud().saveProfile(currentUid, profile)` (lines 1197–1206); call sites at line 1996 (`levelCleared`), 2009 (`gameOver`), 2050 (`showLeaderboard`). So routing the leaderboard write through `saveProfile` reaches all three triggers with no new call site — the "`saveProfile` is the only writer" claim is accurate.
- **Stale comment above `submitBestToCloud` says the leaderboard reads from `users/{uid}`.** Confirmed verbatim at line 1210. The §7.6 instruction to update it is valid.
- **`levelCleared()` is the level-clear handler (line 1971); `gameOver()` at line 2006; there is NO `function levelClear`.** Confirmed. `levelClear` appears only as element id `#levelClear` (line 439), `el.levelClear` handle (line 738), and the state string `state = "levelClear"` (line 1972). Iteration-4 finding 1's correction is accurate — hooking `levelCleared()`/`gameOver()` is right.
- **`hideAllOverlays()` sweeps a HARDCODED array, not `.overlay.show`.** Confirmed at line 2392: `[el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown, el.help, el.scratch, el.leaderboard].forEach(...)`. The §7.5 requirement to add `el.pendingApproval, el.approvalDesk` to this array (and to the `el` map ~line 700) is correct and necessary — new overlays would otherwise never be hidden.
- **`el` map starts ~line 700; `#auth` overlay + `#signupPane` at ~341–367.** Confirmed (el map line 700; auth overlay lines 341–366; `#signupPane` line 357). Adding a role picker to `#signupPane` and sibling overlays after `#auth` is feasible with the existing `.overlay`/`.btn` classes.
- **`cloud()` helper is `() => window.MathQuestCloud` (line 1061).** Confirmed. New `MathQuestCloud` methods (`setLeaderboardEligible`, `claimCode`, `listLinkedStudents`, `approveStudent`, `denyStudent`, `myLinkCode`) are callable as designed.
- **`doSignup()` (line 1073) calls `cloud().signup({userid,email,password})`.** Confirmed. Extending with `role` is feasible; `signup` at line 588 is the place to accept it.
- **`logout()` (line 1163) is the right place to detach the snapshot and reset the flag.** Confirmed — it already nulls `currentUid`/`currentUser` and calls `cloud().logout()`.
- **`questions.js` is the question bank (`MathQuest.Questions.make/hint/videoTopic`), independent of auth.** Confirmed (header + IIFE). Phase 1 does not touch it; no conflict. Keeping it out of scope is correct.
- **Security-rules attack cases.** Walked §6.4 against the ruleset in §6: self-approve via self-update (blocked by `incoming().status == existing().status`), self-link chain (blocked at `linkCodes` create `callerRoleIs`, at `links` create `studentUid != adultUid`, and at `users` adult-approval `request.auth.uid != uid`), cross-user read (blocked by `isSelf || adultLinkedTo`), fabricated score at create (blocked by `best==0`), role escalation on update (blocked by `role` immutability on both branches), approve-without-link (blocked by `exists()`-guarded `approvedLinkExists`), adult over-writing profile under cover of approval (bounded by `onlyStatusAndApprover` diff). No privilege-escalation hole found.

## Unverified / Wrong Assumptions

- **WRONG (Finding 1): `watchMyStatus(cb)` can reference `uid` in the module block.** The module keeps no current-uid state; `uid` must be passed in or read from `auth.currentUser`. See Finding 1.
- **WRONG (Finding 2): existing states include `"pause"` and `"countdown"`.** The actual pause state is `"paused"`; there is no `"countdown"` state. See Finding 2.
- **IMPRECISE (Finding 4): legacy backfill "via the existing `saveProfile`".** `saveProfile`'s fixed destructure cannot write `role`/`status`/`approvedBy`; a separate merge write is needed.
- **NOT VERIFIABLE IN THIS REVIEW:** the composite index `links(adultUid, status)` behind the `where('adultUid','==',me)` + `where('status','in',[...])` query — the design itself flags this as untested (committed, not deployed). The `in` + equality combination does require a composite index in Firestore; declaring it in `firestore.indexes.json` is correct, but whether the live query matches the declared index is confirmable only at deploy/emulator time (out of scope here, and acknowledged by the design).
- **NOT VERIFIABLE IN THIS REVIEW:** `firestore.rules` / `firestore.indexes.json` / `firebase.json` do not yet exist (they are Phase-1 deliverables per §8), so the rules were reviewed as written in §6, not as committed files.

# Phase 1b design: parent progress, privacy fix, legacy invites, role change, invite limit

Stack is locked: single-file `index.html` (inline JS, Firebase SDK 10.12.2 ES modules, no build), `firestore.rules`, emulator tests in `rules-test/`. No Cloud Functions here, so nothing conflicts with Phase 2 (Vertex AI functions will use the Admin SDK and bypass rules; the new `inviteQuota` collection and link name fields are independent of `games/`).

Nothing is pushed, deployed or run against `mathquest-ca395`. The owner deploys rules after merge.

## 1. Item 1b first: privacy hole (rules)

Verified in `firestore.rules`: `adultLinkedTo()` grants `users/{student}` read when `links/{student_adult}` exists and `status != 'denied'`. That includes `invited` (student has not consented) and `requested`. Any adult can invite any userid and read the child's doc (email, uid, scores).

Diff:
- `adultLinkedTo`: replace `.status != 'denied'` with `.status in ['accepted','approved']`. Update the comment (email-invite canonical doc `studentUid_adultUid` is `accepted`, so it is covered).
- Code-requests (`requested`): do NOT loosen user reads. Decision: carry a display name on the link doc. Rule (b) (student creates request) gets: `&& (!('studentName' in incoming()) || (incoming().studentName is string && incoming().studentName.size() <= 40))`. The client writes `studentName` from the student's display name. It is student-typed text, so it is a label only. Trust still comes from the adult's secret code, and the adult sees a name, not email/uid.
- Add an optional `adultName` (<= 40 chars, same check) to invite creation (a). It fixes a current gap: a student cannot read the adult's users doc (A4), so the invite list always shows "An adult". `listMyInvites` will read `data.adultName`.
- Name-field integrity: the update rules (c), (d), (e) each gain `&& incoming().diff(existing()).affectedKeys().hasOnly(['status','decidedAt'])`, so neither party can rewrite `studentName`/`adultName` after creation. Existing tests write only `status` and `decidedAt`; the implementer confirms by running them.
- Pre-existing, not fixed here: `usernames/{userid}` is world-readable and holds `{uid, email}`, so anyone (even signed out) can get a child's email from a userid. The 1b change closes the `users` read only; email is NOT protected overall. Recorded in project-context Open items as a follow-up (needs a server-side login lookup, Phase 2). Student code-requests are also not rate limited; only invites are in scope.
- Header comment: add `A11 (NEW) adult reads a student profile via an un-accepted invite or unapproved request -> adultLinkedTo requires accepted/approved`, plus the quota cases from section 5 (A12-A15; full list in section 5).

Read-path audit (all `users`/`links` reads):
- `users` read = self or `adultLinkedTo` only. After the change, adult progress reads work for `accepted` (userid invite, and email invite via canonical doc) and `approved` (code). They fail for `invited`, `requested`, `denied`.
- `links` read: self student, self adult, or email invite addressed to my email. Unchanged. The adult desk uses only a `links` query by `adultUid`, which passes.
- Adult approval of a code-request (rule 3) needs `approvedLinkExists` only, not a users read, so it still works with the tighter read.
- Side effect: the current `listMyStudents` name lookup silently fails for `invited`/`requested`; it falls back to `targetValue`/`studentName` (see 2).

Existing tests to update deliberately: test `7` seeds an `invited` link and asserts the adult CAN read the student doc. That pins the bug. Change it to seed `accepted` and add the negative cases in section 6. Check tests 3/4/5 for any adult read before accept; adjust the same way.

## 2. Item 1: progress on the adult desk (`index.html`)

- `listMyStudents()` (cloud object, ~line 866): for rows with `status in ['accepted','approved']` and a `studentUid`, `getDoc(users/{uid})` and return `progress: {name, grade, level, best, updatedMs, status}` (picked fields only; never email/uid in the row's display data). Rows `invited` keep `targetValue` + "sent". Rows `requested` use `data.studentName || "(a student)"`. Hide an `email|...` invited row when an accepted row has the same `targetValue` (otherwise the email invitee shows twice).
- `renderMyStudents()` (~line 1623): under `.who` add a `<span class="progress">` using `textContent`: `Grade 3 · Level 5 · Best 120 · Played 2 days ago`. Missing fields are skipped; no `updated` gives "Not played yet". Date helper: relative days, else `toLocaleDateString`. Add CSS `.student-row .progress { flex-basis:100%; font-size:13px; opacity:.85; text-align:left; }` next to the rules at ~line 187 and `flex-wrap: wrap` on `.student-row`.
- Refresh: button `<button class="btn small" id="refreshStudentsBtn">↻ Refresh</button>` in `#approvalDesk` right above `<div id="studentList">`; handler calls `renderMyStudents()`. The list also refreshes on open (existing `showApprovalDesk`).
- Offline/local-only: `cloud()` null returns early as today.
- Failure: a failed users read for one row leaves that row without progress (`console.warn`), not the whole list.
- Activation writes stamp `updated`; when the activation is skipped (section 3) "last played" stays truthful.

## 3. Item 2: active/legacy students get invites

UI:
- Menu: add `<button class="menu-item" id="invitesBtn" style="display:none">📨 Invites / Link a grown-up</button>` after `#studentsBtn` (~line 341). In `enterGame` branch (3) set display to `""` when `role === 'student'` or (legacy: `!role && fromCloud`); set `none` in branches (1)/(2) and in logout (~line 1722). Pending students keep the existing pending screen unchanged.
- Overlay: new `<div id="studentInvites" class="overlay">` after `#pendingApproval`, with `#activeInviteList`, `#activeCodeInput`, `#activeCodeSendBtn`, `#activeInviteMsg`, and "Back to game" `#activeInvitesCloseBtn` (shows `el.start`, state `start`). Copy: "Link a grown-up 👪".
- Add `studentInvites: document.getElementById("studentInvites")` to the `el` map (~line 1068) AND to the array in `hideAllOverlays()` (~line 2987).
- Refactor `renderMyInvites(listEl, msgEl)` and `onAcceptInvite(..., msgEl)` to take targets (defaults = pending screen elements, so pending behavior is identical). Decline button: not added, since no client decline code exists (rule (e) allows it; out of scope).
- `#invitesBtn` handler mirrors `#studentsBtn` (~line 2904), including its known "ends a mid-run game" behavior.

Cloud (no rules change expected):
- `acceptInvite({..., activate})`: `activate` true only for `status === 'pending'` (pending screen call passes true). For active students skip the `users` update. Reason: rule (2) requires existing `pending`; rule (1) forbids changing `approvedBy`, so the write would be denied and previously-linked approver would be lost.
- Userid invite: rule (c) `invited -> accepted`. Email invite: canonical `studentUid_adultUid` create (c2) via `emailInviteToMe`.
- `requestByCode` unchanged for active students (rule (b) needs only the target to be an adult) plus `studentName`.
- `approveStudent`: after the link flips to `approved`, `getDoc(users/{student})`; write the activation ONLY if `d.exists() && d.data().role === 'student' && d.data().status === 'pending'`; otherwise skip the write and return ok. A bare `status !== 'active'` check is wrong: an un-backfilled legacy doc has no `role`/`status`, so rule (3) would error on the missing field and leave a half-approved link. Skipping also avoids overwriting an active student's `approvedBy`/`updated`. Test: approving a code-request from a role-less legacy doc leaves the link `approved`, attempts no users write, returns ok, and the adult can then read the doc.
- `listMyInvites`: add a third query `links where studentUid == me and status in ['accepted','approved']`. Drop any `email|...` invited row whose `adultUid` already has a canonical row, and render linked adults as "Linked ✓" with no button. Reason: rule (c2) leaves the original `email|...` doc `invited` forever, and Accept on it would always fail (rule (c) is userid-only). Pending-screen behavior is unchanged except it also shows "Linked ✓" rows.
- Live activation: a pending student who becomes active without relogin gets the menu item too. Set `invitesBtn.style.display = ""` in `onMyStatus` on activation and in both `justActivated` handlers (~2555, ~2570), not only `enterGame` branch (3).

Risks specific to legacy docs: an old doc may lack `email` (email invites then fail closed because `callerEmail()` errors; userid invites still work) or lack a `usernames/{userid}` entry (adult's userid invite says "No student with that user ID"; email invite is the path). The emulator test seeds a legacy doc both with and without `email` to document this. No rule change unless a flow fails for a doc that does have email and usernames.

## 4. Item 3: role change (decision, recommend (a))

Recommendation: (a) no in-app role change; ship a short owner-only console procedure, keep rules unchanged. No script.

Why not (b): legacy role-less docs are children's accounts; a self-upgrade to `teacher/parent` would let any such child mint a linkCode, invite or approve students, and read other children's progress. Gating by anything the client can supply (a secret, an email) is not verification. (c) Adult verification needs a trusted server step, which is Phase 2 (Cloud Functions) territory; revisit there.

Why no script: the only owner-credential route is reusing the Firebase CLI's stored refresh token with the CLI's OAuth client, which depends on CLI internals and is easy to get wrong. A rare, one-account edit in the console is simpler, auditable and safe. If the owner wants a script later, it should be a separate decision.

Deliverable: a short "Owner: change an account's role" section in a NEW root `README.md` (none exists today; keep it to essentials). Steps for converting account `<uid>` to teacher/parent: (1) in `users/<uid>` set `role`, `status: "active"`, `approvedBy: null`, `linkCode: "<7-char code from the allowed alphabet>"` (2) create `linkCodes/<CODE>` = `{adultUid: "<uid>", role: "<role>"}` (3) delete any `links` docs with `studentUid == <uid>` and any `leaderboard/<uid>` row if wanted (4) tell the user to log out/in. Rules and tests are unchanged, so immutability still holds. The human can veto and pick (b) self-upgrade for role-less docs, or (c) server-verified adult upgrade.

## 5. Item 4: invite rate limit (rules)

Limit: 30 new invites per adult per UTC day. A class is typically 20-30 students; 30 allows a full class in a day yet caps spam. The constant lives in one rules function `inviteDailyLimit()`.

Data shape: `inviteQuota/{adultUid}_{yyyymmdd}` = `{ adultUid, day (int yyyymmdd), count (int), lastLinkId (string) }`. One doc per adult-day; rollover is a new doc id (the client cannot choose the day because rules derive it from `request.time`). Old docs are negligible and never read.

Rules, written out (all new, in `firestore.rules`):

```
function inviteDailyLimit() { return 30; }
function todayKey() { return request.time.year()*10000 + request.time.month()*100 + request.time.day(); }
function quotaId(uid) { return uid + '_' + string(todayKey()); }
function quotaPath(uid) { return /databases/$(database)/documents/inviteQuota/$(quotaId(uid)); }
function invitePaired() {   // the quota write is accompanied by a NEW invite link of mine in the same batch
  return !exists(/databases/$(database)/documents/links/$(incoming().lastLinkId))
    && existsAfter(/databases/$(database)/documents/links/$(incoming().lastLinkId))
    && getAfter(/databases/$(database)/documents/links/$(incoming().lastLinkId)).data.adultUid == request.auth.uid
    && getAfter(/databases/$(database)/documents/links/$(incoming().lastLinkId)).data.status == 'invited';
}
function quotaOk(qid) {
  return signedIn() && callerRoleIs(['teacher','parent'])
    && incoming().adultUid == request.auth.uid
    && qid == quotaId(request.auth.uid)            // day comes from request.time, never the client
    && incoming().day == todayKey()
    && incoming().count is int && incoming().lastLinkId is string
    && incoming().keys().hasOnly(['adultUid','day','count','lastLinkId'])
    && invitePaired();
}
match /inviteQuota/{qid} {
  allow read: if signedIn() && qid.matches(request.auth.uid + '_[0-9]{8}');  // works for missing docs
  allow create: if quotaOk(qid) && incoming().count == 1;
  allow update: if quotaOk(qid) && incoming().count == existing().count + 1
                && incoming().count <= inviteDailyLimit();
  allow delete: if false;
}
```

- Link create (a) gains: `&& getAfter(quotaPath(request.auth.uid)).data.lastLinkId == linkId && getAfter(quotaPath(request.auth.uid)).data.count == (exists(quotaPath(request.auth.uid)) ? get(quotaPath(request.auth.uid)).data.count : 0) + 1`. `lastLinkId == linkId` stops one quota bump from covering two links in a batch. An invite without a quota write fails (`getAfter` of a missing doc errors, which denies). `qid` is a parameter of `quotaOk` because it is only in scope inside the `match`.
- Step 0 for the implementer, before writing any tests: compile the rules in the emulator and confirm `string(int)` and `request.time.year()/month()/day()` are accepted (not verified by me). Fallback if `string(int)` is rejected: key on `string(int(math.floor(request.time.toMillis() / 86400000)))`, still derived from `request.time`; if that is also rejected, stop and report.- Client `inviteStudent`: `runTransaction` (add to the import list): read the quota doc, compute `count`, then `tx.set(quota)` and `tx.set(link)`. It accepts a read-miss as 0. On limit/permission failure: `getDoc(quota)`; if `count >= 30` show "You've sent a lot of invites today, try again tomorrow."; else if the link id already exists "You're already linked with, or have already invited, that student."; otherwise (count < 30 and no existing link, i.e. clock/timezone denial) "Couldn't send. Check your device date and time, then try again." The client computes the quota id with UTC: `const d=new Date(); const day=d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();` and uses the same `day` for the doc id `{uid}_{day}` and the `day` field. Tests use one `utcDayKey()` helper read once per test to avoid 00:00 UTC flakes.`n- Overlay accept (item 2): after `res.ok` call `renderMyInvites(listEl,msgEl)` and set `msgEl.textContent="Linked ✓"`, since no `onMyStatus` snapshot fires for a link-only accept.
- Dedupe: link ids are deterministic. Re-inviting an existing id is an update, which no rule allows, so the whole transaction is rejected and quota is not consumed. The same applies to a previously denied invite (existing limitation, now with a clearer message).
- Document-access limits: invite create evaluates `callerRoleIs` (exists+get on `users/me`) plus quota `exists/get/getAfter`; quota write evaluates `callerRoleIs` plus `exists/existsAfter/getAfter` on the link. Repeated access to the same path is cached and counts once, so a link create touches about 3 distinct documents (users/me, quota, and the quota-after) and a quota write about 3 (users/me, link, link-after). That is well under the 10 per operation and 20 per request limits. The test run reports that the batch at the 30th invite passes; exact counts are reported only if the emulator exposes them.
- `firestore.indexes.json`: no change (no new queries).
- Header comment: `A12 adult exceeds the daily limit`, `A13 adult resets/decrements/deletes quota or picks another day`, `A14 student or non-adult writes quota`, `A15 one quota bump covering several invites / quota bump with no invite`.

## 6. Test plan

Rules emulator (`rules-test/rules.test.js`, new tests appended, helpers extended to seed quota via the admin context):
- 1b: adult cannot read `users/STU` with link `invited`; with `requested`; with `denied`. Can read after userid accept (`accepted`), after canonical email accept, after code approval (`approved`). Cannot read an unrelated student. Student with `studentName` > 40 chars cannot create the request. Update test 7 as described.
- Item 2: seed a legacy-active student (with `role` backfilled, status active, approvedBy null). Complete each of three flows (userid accept link-only, email canonical accept, code request then adult approval) and then assert the adult reads the doc. Assert a link-only accept does not touch `users`, and that the same student cannot write the pending->active branch (still denied).
- Item 4: 30 transactions succeed, 31st fails; invite without quota fails; quota without invite fails; two links under one bump fails; decrement/reset/delete fail; wrong `day` or a fake `adultUid` fails; student and non-adult cannot write quota; another adult cannot read my quota; day rollover: `@firebase/rules-unit-testing` has no clock control, so rollover is tested indirectly by writing a quota doc with a different day id (denied for today's write) and by a static assertion of `todayKey()`; stated as not executed against a real date change.
- Existing tests under the quota rule: tests 3 (line ~81) and 4 (~91) call a bare `setDoc` on an invite link and WOULD FAIL; the negative invite tests (4b, 14a, 14b and any other `assertFails` on invite creation) would pass for the WRONG reason (no quota). Add a helper `inviteBatch(db, adultUid, linkId, linkData)` that, in one batch, writes the quota doc (count = current+1, `lastLinkId = linkId`) and the link. Use it in 3, 4, 4b, 14a, 14b and every other invite-creating test (15/16 variants); each negative test must assert the quota half is valid in the same batch so the failure is attributable to the original rule (N1, N4, N5, lowercase). Test 7 is edited as in section 1. Everything else, including A1-A10 and N1-N6, is unchanged and must pass.

Client (reuse the `fix-student-pending/diagnosis.md` approach: extract the real module block and functions from `index.html`, retarget SDK to Auth+Firestore emulators with deployed-candidate rules, stub UI helpers): adult invites a legacy active student by userid and by email; student accepts through the new path with `activate:false`; adult `listMyStudents` returns progress and no email/uid in display fields; after an email accept `listMyInvites` shows that adult as Linked with no Accept; a pending student activated live gets the menu item (traced); approving a code-request from a role-less legacy doc leaves the link `approved` with no users write; code fallback for an active student; 31st invite returns the friendly limit message; duplicate invite returns the "already linked/invited" message and quota does not change; pending student flow and legacy backfill unchanged. DOM (overlay show/hide, `el` map and `hideAllOverlays` entries, menu visibility) is traced and checked by a string/AST check unless jsdom installed outside the repo is available; I will state which it was.

## 7. Risks

- Tightening reads is a behavior change: adults with `invited`/`requested` links lose profile reads until acceptance (intended). An old client against new rules just shows labels instead of names.
- Old clients cannot send invites under the new rules (no quota write). A NEW client against OLD rules also fails to invite (the `inviteQuota` write is default-denied). Deploy order: owner deploys rules first, then merges the PR (Pages) immediately after; the window where invites fail is short and only affects adults.
- `getAfter` pairing is the highest-risk logic; covered by the batch tests above.
- UTC day boundary may differ from the family's local day; message says "tomorrow".
- Student-typed `studentName` can be misleading; the adult still must hold the code.
- Mid-run menu open ends the run (known).
- `usernames` leaks child emails to anyone (pre-existing, not fixed here, see section 1).

## 8. Deliverables beyond code
- Rules header comment (A11-A15), `rules-test` additions, root `README.md` owner-role section, and the project-context Phase log / Open items update (remove the three fixed items, add the usernames leak and the role-change decision) before reporting the phase done.

## Review responses (iteration 2)
- F1 fixed: UTC day key, helper, third (clock) message in section 5.
- F2 fixed: add tests: adultName/studentName 41 chars, non-string, and 40 chars OK; (c) accept with extra adultName denied; (d) approve/deny changing studentName denied; (e) decline by either party changing a name denied; each with a status+decidedAt-only control.
- F3-F6 fixed as above (F5: A11-A15 everywhere; F6: (b)/(c) defined, root README.md created).
- F7: Risks addition: the per-adult quota does not stop spam from many self-registered adult accounts (role is chosen at signup); it is a rate limit, not an abuse-proof control. Real fix is adult verification in Phase 2.


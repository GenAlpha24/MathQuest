# Phase 1b design: parent progress, privacy fix, legacy invites, role change, invite limit

Stack is locked: single-file `index.html` (inline JS, Firebase SDK 10.12.2 ES modules, no build), `firestore.rules`, emulator tests in `rules-test/`. No Cloud Functions here, so nothing conflicts with Phase 2 (Vertex AI functions will use the Admin SDK and bypass rules; the new `inviteQuota` collection and link name fields are independent of `games/`).

Nothing is pushed, deployed or run against `mathquest-ca395`. The owner deploys rules after merge.

## 1. Item 1b first: privacy hole (rules)

Verified in `firestore.rules`: `adultLinkedTo()` grants `users/{student}` read when `links/{student_adult}` exists and `status != 'denied'`. That includes `invited` (student has not consented) and `requested`. Any adult can invite any userid and read the child's doc (email, uid, scores).

Diff:
- `adultLinkedTo`: replace `.status != 'denied'` with `.status in ['accepted','approved']`. Update the comment (email-invite canonical doc `studentUid_adultUid` is `accepted`, so it is covered).
- Code-requests (`requested`): do NOT loosen user reads. Decision: carry a display name on the link doc. Rule (b) (student creates request) gets: `&& (!('studentName' in incoming()) || (incoming().studentName is string && incoming().studentName.size() <= 40))`. The client writes `studentName` from the student's display name. It is student-typed text, so it is a label only. Trust still comes from the adult's secret code, and the adult sees a name, not email/uid.
- Add an optional `adultName` (<= 40 chars, same check) to invite creation (a). It fixes a current gap: a student cannot read the adult's users doc (A4), so the invite list always shows "An adult". `listMyInvites` will read `data.adultName`.
- Header comment: add `A11 (NEW) adult reads a student profile via an un-accepted invite or unapproved request -> adultLinkedTo requires accepted/approved`, plus the quota cases from section 5 (A12-A14).

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
- `approveStudent`: after the link flips to `approved`, `getDoc(users/{student})`; only write the activation if `status !== 'active'`. This avoids overwriting an active student's `approvedBy` and `updated`.

Risks specific to legacy docs: an old doc may lack `email` (email invites then fail closed because `callerEmail()` errors; userid invites still work) or lack a `usernames/{userid}` entry (adult's userid invite says "No student with that user ID"; email invite is the path). The emulator test seeds a legacy doc both with and without `email` to document this. No rule change unless a flow fails for a doc that does have email and usernames.

## 4. Item 3: role change (decision, recommend (a))

Recommendation: (a) no in-app role change; ship a short owner-only console procedure, keep rules unchanged. No script.

Why not (b): legacy role-less docs are children's accounts; a self-upgrade to `teacher/parent` would let any such child mint a linkCode, invite or approve students, and read other children's progress. Gating by anything the client can supply (a secret, an email) is not verification. (c) Adult verification needs a trusted server step, which is Phase 2 (Cloud Functions) territory; revisit there.

Why no script: the only owner-credential route is reusing the Firebase CLI's stored refresh token with the CLI's OAuth client, which depends on CLI internals and is easy to get wrong. A rare, one-account edit in the console is simpler, auditable and safe. If the owner wants a script later, it should be a separate decision.

Deliverable: `docs/owner-set-role.md` (short). Steps for converting account `<uid>` to teacher/parent: (1) in `users/<uid>` set `role`, `status: "active"`, `approvedBy: null`, `linkCode: "<7-char code from the allowed alphabet>"` (2) create `linkCodes/<CODE>` = `{adultUid: "<uid>", role: "<role>"}` (3) delete any `links` docs with `studentUid == <uid>` and any `leaderboard/<uid>` row if wanted (4) tell the user to log out/in. Rules and tests are unchanged, so immutability still holds. The human can veto and pick (b)/(c).

## 5. Item 4: invite rate limit (rules)

Limit: 30 new invites per adult per UTC day. A class is typically 20-30 students; 30 allows a full class in a day yet caps spam. The constant lives in one rules function `inviteDailyLimit()`.

Data shape: `inviteQuota/{adultUid}_{yyyymmdd}` = `{ adultUid, day (int yyyymmdd), count (int), lastLinkId (string) }`. One doc per adult-day; rollover is a new doc id (the client cannot choose the day because rules derive it from `request.time`). Old docs are negligible and never read.

Rules:
- `function todayKey() { return request.time.year()*10000 + request.time.month()*100 + request.time.day(); }`; `quotaPath(uid)` = `inviteQuota/$(uid + '_' + string(todayKey()))`.
- `match /inviteQuota/{qid}`: `read` if `signedIn() && qid.matches(request.auth.uid + '_[0-9]{8}')` (works for non-existent docs, unlike `resource` checks). `delete` false.
  - `create`: `isSelf(incoming().adultUid)`, `callerRoleIs(['teacher','parent'])`, `qid == adultUid + '_' + string(todayKey())`, `incoming().day == todayKey()`, `count == 1`, keys `hasOnly`, plus `invitePaired()`.
  - `update`: same owner/role/day, `incoming().count == existing().count + 1`, `incoming().count <= inviteDailyLimit()`, `adultUid`/`day` unchanged, plus `invitePaired()`.
  - `invitePaired()`: `!exists(links/lastLinkId) && existsAfter(links/lastLinkId) && getAfter(links/lastLinkId).data.adultUid == request.auth.uid && .status == 'invited'`. A quota bump with no new invite fails.
- Link create (a) gains: `&& getAfter(quotaPath(uid)).data.lastLinkId == linkId && getAfter(quotaPath(uid)).data.count == (exists(quotaPath(uid)) ? get(quotaPath(uid)).data.count : 0) + 1`. `lastLinkId == linkId` stops one quota bump from covering two links in a batch. An invite without a quota write fails (`getAfter` of a missing doc errors, which denies).
- Client `inviteStudent`: `runTransaction` (add to the import list): read the quota doc, compute `count`, then `tx.set(quota)` and `tx.set(link)`. It accepts a read-miss as 0. On limit/permission failure: `getDoc(quota)`; if `count >= 30` show "You've sent a lot of invites today, try again tomorrow."; otherwise "You already invited that student (or they declined)."
- Dedupe: link ids are deterministic. Re-inviting an existing id is an update, which no rule allows, so the whole transaction is rejected and quota is not consumed. The same applies to a previously denied invite (existing limitation, now with a clearer message).
- Document-access limits: invite create evaluates `callerRoleIs` (exists+get on `users/me`) plus quota `exists/get/getAfter`; quota write evaluates `callerRoleIs` plus `exists/existsAfter/getAfter` on the link. Static upper bound without caching is about 8 per operation, under the 10 per-operation limit (20 per commit). The test run reports the static count and the pass result at the limit; if the emulator debug log exposes counts, those are reported too.
- `firestore.indexes.json`: no change (no new queries).
- Header comment: `A12 adult exceeds the daily limit`, `A13 adult resets/decrements/deletes quota or picks another day`, `A14 student or non-adult writes quota`, `A15 one quota bump covering several invites / quota bump with no invite`.

## 6. Test plan

Rules emulator (`rules-test/rules.test.js`, new tests appended, helpers extended to seed quota via the admin context):
- 1b: adult cannot read `users/STU` with link `invited`; with `requested`; with `denied`. Can read after userid accept (`accepted`), after canonical email accept, after code approval (`approved`). Cannot read an unrelated student. Student with `studentName` > 40 chars cannot create the request. Update test 7 as described.
- Item 2: seed a legacy-active student (with `role` backfilled, status active, approvedBy null). Complete each of three flows (userid accept link-only, email canonical accept, code request then adult approval) and then assert the adult reads the doc. Assert a link-only accept does not touch `users`, and that the same student cannot write the pending->active branch (still denied).
- Item 4: 30 transactions succeed, 31st fails; invite without quota fails; quota without invite fails; two links under one bump fails; decrement/reset/delete fail; wrong `day` or a fake `adultUid` fails; student and non-adult cannot write quota; another adult cannot read my quota; day rollover: `@firebase/rules-unit-testing` has no clock control, so rollover is tested indirectly by writing a quota doc with a different day id (denied for today's write) and by a static assertion of `todayKey()`; stated as not executed against a real date change.
- Existing 33 tests must still pass apart from the deliberate edit to 7; attack tests A1-A10, N1-N6 unchanged.

Client (reuse the `fix-student-pending/diagnosis.md` approach: extract the real module block and functions from `index.html`, retarget SDK to Auth+Firestore emulators with deployed-candidate rules, stub UI helpers): adult invites a legacy active student by userid and by email; student accepts through the new path with `activate:false`; adult `listMyStudents` returns progress and no email/uid in display fields; code fallback for an active student; 31st invite returns the friendly limit message; duplicate invite returns the "already invited" message and quota does not change; pending student flow and legacy backfill unchanged. DOM (overlay show/hide, `el` map and `hideAllOverlays` entries, menu visibility) is traced and checked by a string/AST check unless jsdom installed outside the repo is available; I will state which it was.

## 7. Risks

- Tightening reads is a behavior change: existing `invited`-state adults lose profile reads until acceptance (intended). After deploy, the rules must go out before or with the client; a new client against old rules still works (name fields are extra keys), an old client against new rules just shows labels instead of names.
- Old clients cannot send invites under the new rules (no quota write). Deploy order: owner deploys rules, then merges the PR (Pages) immediately after; the window where invites fail is short and only affects adults.
- `getAfter` pairing is the highest-risk logic; covered by the batch tests above.
- UTC day boundary may differ from the family's local day; message says "tomorrow".
- Student-typed `studentName` can be misleading; the adult still must hold the code.
- Mid-run menu open ends the run (known).

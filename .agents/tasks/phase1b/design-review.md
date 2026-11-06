# Design review: phase1b-parent-portal-and-limits.md

Branch checked: feature/parent-portal-and-invite-limits. Read: the design, `firestore.rules`, `rules-test/rules.test.js` (grep of tests/seeds), `index.html` (cloud object lines ~830-1010, UI ~1505-1715, anchors via grep).

Verdict: CHANGES_REQUESTED (2 MEDIUM, 0 HIGH).

## Findings

1. MEDIUM. Deploy order is stated two ways. The intro says "The owner deploys rules after merge". Section 7 says "owner deploys rules first, then merges the PR". Merge publishes Pages immediately (project-context), and a new client against old rules cannot invite at all (`inviteQuota` is default-denied). Fix: delete the intro sentence and state once, in Section 7 and in the PR body: "Deploy `firebase deploy --only firestore:rules --project mathquest-ca395` FIRST, then merge." Also add that the reverse order breaks adult invites until rules are deployed. Old client + new rules is the safe direction for everything except sending invites.

2. MEDIUM. Section 6 says each negative invite test "must assert the quota half is valid in the same batch so the failure is attributable to the original rule (N1, N4, N5, lowercase)". For N1/N4 (student author) and N5 (link names another adult) this is impossible. `quotaOk` itself requires `callerRoleIs(['teacher','parent'])` and `getAfter(link).data.adultUid == request.auth.uid`, so the quota half is invalid by construction, and the batch fails for two reasons. A single `setDoc` cannot isolate the link rule either: `getAfter(quota)` equals `get(quota)` outside a batch, so `count == prev+1` always fails. Fix: replace the wording with a positive-control rule. For every negative invite test, run the same `inviteBatch` helper immediately before with only the tested field corrected (it must succeed, using a fresh link id/quota state), then the negative variant. State in the file that N1/N4/N5 are over-determined by design. Optionally also run the pre-change versions of these negative tests against the previous rules file (`git show main:firestore.rules`) to prove the original rule alone denies them.

3. NIT. Section 5 contains a literal `` `n `` where a newline was intended ("...00:00 UTC flakes.`n- Overlay accept"). The overlay-accept bullet is mis-rendered. Fix: split into two bullets.

4. NIT. Rule (c2) (canonical email-accept create) and (b) have no key allowlist, so a student can attach arbitrary extra fields (including a very large `studentName` on a (c2) doc). Display uses `textContent` and only `requested` rows show `studentName`, so low impact. Fix: add `&& incoming().keys().hasOnly(['studentUid','adultUid','adultRole','source','targetKind','targetValue','status','createdBy','createdAt','decidedAt','studentName'])` to (b) and (c2) (names must match what the client writes at index.html lines 940-945 and 964-969), or accept and note.

5. NIT. `invitePaired` builds a path from client-supplied `lastLinkId`. A value containing `/` makes a nested path. It cannot pass the link-create check (`lastLinkId == linkId`, a single segment), so the only effect is a self-inflicted quota bump. Fix: add `&& !incoming().lastLinkId.matches('.*/.*')`.

6. NIT. Dedupe of the `email|...` invited row in `listMyStudents` matches on `targetValue`. The canonical doc's `targetValue` comes from `auth.currentUser.email` (index.html line 938) while the rule matches on the `users.email` field. These can differ, leaving a duplicate row. Fix: also dedupe when the accepted row's `adultUid`+`studentUid`... or simply hide `email|` rows when any accepted row exists with the same `targetValue` OR note the edge.

7. NIT. Pre-existing and out of scope but relevant to the privacy goal: `usernames/{userid}` is world-readable with `{uid,email}`, and `users.email` is self-asserted (create/update rules never compare it to `request.auth.token.email`), so a student can claim another address and accept an email invite meant for someone else. The design discloses the first point; the second is not mentioned. Fix: add both to project-context Open items as Phase 2 follow-ups.

## Verified Assumptions

- No new privilege escalation found. Walked every users/links write path: adult cannot reach `accepted` (rule (c) needs `studentUid == auth.uid`; (c2) needs `isSelf(studentUid)`), adult cannot create `requested` or `accepted` (a requires `invited`), student cannot create `invited` (a needs adult role). Tightened `adultLinkedTo` only removes access.
- `firestore.rules` facts match the design: `adultLinkedTo` uses `status != 'denied'`; (c)/(d)/(e) have no diff restriction today; (a) email id/regex; (b) has no name field; `'k' in incoming()` syntax is already used (`!('role' in existing())`).
- Privacy fix completeness: `users` read is only `isSelf || adultLinkedTo` (one place). With `accepted/approved` it covers userid accept, email accept (canonical `studentUid_adultUid`, created by (c2) as `accepted`), and code approval. `links` reads are unchanged and sufficient: the adult desk only queries `adultUid == me`, which passes rule `isSelf(existing().adultUid)`; the invitee reads email invites via `targetValue == callerEmail()`. Approval branch (3) uses `approvedLinkExists`, not a users read. `approveStudent`'s new `getDoc(users)` runs after the link flips to `approved`, so it is allowed.
- Legacy active students (role backfilled or not): (c) needs only `existing().studentUid == auth.uid`; (c2) needs `users/me.email` (fails closed without it, as the design says); (b) needs only an adult target. None requires student role/status, so no rules change is needed. Skipping the `users` write when status is not `pending` is correct (rule (2) needs `pending`, rule (1) forbids changing `approvedBy`, rule (3) needs `existing().role`).
- Rate limit is enforceable: link create needs `getAfter(quota).lastLinkId == linkId` and `count == prev+1`; a single `setDoc` fails because `getAfter` equals `get` outside a batch; two links in one batch cannot both match one `lastLinkId`; `count <= 30` on update; create forces `count == 1`; delete false; student/non-adult fail `callerRoleIs`; day id comes from `request.time`. Document-access: link create about 3 distinct docs, quota write about 4 (users/me, link exists, existsAfter, getAfter), whole batch about 8, under the 10-per-operation and 20-per-request limits.
- Testable in the emulator: `request.time` is real time, a helper reads the UTC day once; day rollover correctly stated as not executable.
- Index.html anchors exist: `#studentsBtn` (line 341), `#pendingApproval` (401), `#approvalDesk` (415), `#studentList` (423), `.student-row` CSS (181-188), `listMyStudents` (866), `listMyInvites` (893), `acceptInvite` (933), `requestByCode` (954), `approveStudent` (975), `el` map (~1068-1077), `renderMyInvites` (1553), `onAcceptInvite` (1587), `showApprovalDesk` (1615), `renderMyStudents` (1623), `onMyStatus` (1693), logout `studentsBtn` hide (1722), `justActivated` handlers (2555, 2570), `studentsBtn.onclick` (2904), `hideAllOverlays` (2985). Firestore import list (line 586) lacks `runTransaction`, as the design says. `storedEmail` is set for every login (line 1511), so the overlay's `renderMyInvites` email query works for active students.
- Existing tests that break are correctly identified: 3 (line 81), 4 (line 91) use bare `setDoc` invites; 7 (line 143) pins the bug; 14a/14b/4b negatives.
- Item 3: recommendation (a) is sound and is the default; the link-code alphabet in the README step matches `LINKCODE_ALPHABET` (7 chars, no I/O/0/1); no root README exists today.

## Unverified / Wrong Assumptions

- Not verified (the design itself says so): `string(int)` and `request.time.year()/month()/day()` compile in the emulator; the design has a Step 0 and a fallback, acceptable.
- Not verified by me: the exact access-call count (no emulator run); my estimate is above.
- Wrong: "each negative test must assert the quota half is valid" (finding 2).
- Wrong/inconsistent: deploy order (finding 1).
- Not run by me: no rules compile, no tests.

# Review: fix/student-pending-routing

Verdict: APPROVED (no HIGH/MEDIUM blockers).

Evidence base: diff main...HEAD (index.html + diagnosis.md only), commit message execution record, diagnosis.md, firestore.rules read in full. I did not re-run the suites.

1. Root cause. The record shows a before-fix execution: the real module and real enterGame against the deployed rules gave student -> shown=["start"], state=start, and the doc was correctly pending/student. That reproduces the user's symptom. The code path matches: createUserWithEmailAndPassword fires onAuthStateChanged before signup() writes users/{uid}; enterGame gets a null profile and takes branch 3. Other hypotheses: payload role/status is correct in the code, and the diagnosis rules them out. The backfill attempt in that path was denied by the rules (create needs pending; 1b needs a role-less existing doc), so no activation occurred. The second bug (the linkCodes rule needs the caller's users doc, so it was written too early) is a real ordering defect and is fixed.

2. Privilege escalation. firestore.rules is unchanged (no diff). backfillRole is now stricter: it needs `!role && fromCloud`, so a missing or cached doc never triggers it. A new student's doc has role=student, so `!role` is false and no backfill runs. Rule 1b still needs a doc without `role`, and the create rule requires a role, so a new student cannot be role-less. No new self-activation path.

3. Behavior.
   - Legacy role-less doc: fromCloud is true, so it goes to start and backfills (executed in the record).
   - Offline/local-only: cloud() is null or the profile comes from the cache. It lands in branch 3 without backfill, and the gating in onAuthChange is a no-op when signingUp is false.
   - Active user login: unchanged.
   - Teacher/parent: approvalDesk with the linkCodes ordering fix (executed in the record).
   - New student: pending with #pendingApproval (executed in the record).
   - Failed signup: a half-created account is signed out (held and !ok).

4. Scope. The diff covers only index.html and the diagnosis doc. Untracked index-Crayon-version.html and index-Original.html are untouched (timestamps predate the work). rules-test/ is an untracked harness (node_modules only). main == origin/main and no new remote branch exists, so there was no push or deploy.

Residual, not blocking (LOW): the browser DOM and the live project were not executed (the record says so). A transient loadProfile failure for an existing pending student falls to the start screen as before. That is a pre-existing offline fallback, and the rules still gate leaderboard writes and status.

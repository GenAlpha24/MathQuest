# Diagnosis: new STUDENT goes straight into the game

Root cause (hypothesis 2, race): `createUserWithEmailAndPassword` fires `onAuthStateChanged` before
`signup()` has written `users/{uid}`. `enterGame` ran concurrently, `loadProfile` returned null, the default
profile has no role, and branch 3 showed the start screen (state='start'). The users doc was written
moments later as role student/status pending, so the DB was correct but the UI was not.

Not an unintended self-activation: `backfillRole` was called by that branch, but the deployed rules DENIED it
(create rule needs status 'pending'; 1b needs a doc without `role`). Rules held; no rules change needed.
Hypotheses 1, 3, 4: ruled out (signup payload has role/status; field names correct; only path is onAuthChange->enterGame).
Hypothesis 5: not needed; the code on main reproduces it.

Second bug found: adult signup created `linkCodes/{code}` BEFORE the users doc, but the linkCodes create rule
requires the caller's users doc to already have the role, so adult signup was denied (rule evaluation error at that line).

## Executed (emulator, deployed firestore.rules, project demo-mathquest)
Ran the REAL module block extracted from index.html (SDK retargeted to the Auth+Firestore emulators) plus the REAL
`enterGame` source extracted from index.html (UI helpers stubbed).
- Before: student signup -> shown=["start"], state=start, backfillCalled=true, backfill DENIED, doc pending. (bug reproduced)
- Before: teacher signup -> PERMISSION_DENIED on linkCodes create.
- After: student -> pendingApproval, state=pending, no backfill, doc pending/student.
- After: teacher, parent -> approvalDesk, docs active. 
- After: pre-existing role-less doc -> start screen, backfill OK -> student/active, best preserved.
Only traced, not executed: real browser DOM/overlay rendering and the live project.

## Fix (index.html)
1. `onAuthChange` holds the sign-in while `signup()` runs; `signup()` releases it after the users doc is written
   (on failure with a half-created account it signs out).
2. Adult signup writes linkCodes after the users doc.
3. `enterGame` backfills only when the profile came from an existing Firestore doc (not cache/default).

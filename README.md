# MathQuest

Single-file game (`index.html` + `questions.js`) on GitHub Pages, backed by Firebase project `mathquest-ca395` (Auth + Firestore). `firestore.rules` is the security layer.

## Deploy order (rules changes)
1. Owner deploys the rules first: `firebase deploy --only firestore:rules,firestore:indexes --project mathquest-ca395`
2. Then merge/publish the client. A new client against old rules cannot send invites (the quota write is denied).

## Run the rules tests
```
cd rules-test; npm ci; cd ..
firebase emulators:exec --only firestore --project demo-mathquest "node --test rules-test/rules.test.js"
```
Needs Node 20+, the Firebase CLI and Java 11+. Runs against the emulator only.

## Owner only: change an existing account's role
There is no in-app role change on purpose: roles are immutable in the rules, and letting an account upgrade itself would let a child mint adult powers. To turn account `<uid>` into a teacher or parent, use the Firebase console (Firestore) as the project owner:
1. `users/<uid>`: set `role` to `teacher` or `parent`, `status` to `active`, `approvedBy` to `null`, and add `linkCode` = a unique 7-character code (letters A-Z without I/O, digits 2-9).
2. Create `linkCodes/<CODE>` = `{ adultUid: "<uid>", role: "<role>" }`.
3. Delete any `links` docs where `studentUid` is `<uid>` (old student links), and `leaderboard/<uid>` if you want the row gone.
4. Ask the user to log out and back in.
Never do this for an account you cannot verify is an adult.

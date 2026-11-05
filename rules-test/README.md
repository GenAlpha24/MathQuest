# Firestore rules tests

Runs `../firestore.rules` against the local Firestore emulator (project `demo-mathquest`, no login, no live Firebase access).

## Requirements
- Node 20+, Firebase CLI, and Java 11+ (the emulator is a Java jar; first run downloads it).

## Run (from repo root)
```
cd rules-test; npm install; cd ..
firebase emulators:exec --only firestore --project demo-mathquest "node --test rules-test/rules.test.js"
```
If `java` isn't on PATH in your shell, prepend its `bin` dir to `$env:PATH` first.

## Covered (33 tests, `node:test`)
- Positive: signup (student/teacher/parent), legacy role backfill (rule 1b) + later progress saves,
  userid invite chain, email invite chain with mixed-case stored email (c2), code fallback,
  leaderboard writes/reads, linked-adult and self reads.
- Negative: attack cases A1-A10 and N1-N6 from the top of `firestore.rules`, plus usernames,
  links and linkCodes immutability/delete rules.
- Behavior pinned: a legacy role-less player can't save progress or write the leaderboard until
  `backfillRole` runs (the client does this first at login).

Negative tests use `assertFails`, which passes on any denial (including rule evaluation errors), so
each negative test is paired with a positive control for the same path where it matters.

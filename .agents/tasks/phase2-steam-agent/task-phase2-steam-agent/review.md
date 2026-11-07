# Phase 2: STEAM game-builder callable and Create a Game client

Adds a `generateGame` 2nd-gen callable (pre-filter, transactional quota, Gemini classify then generate, strict validation, save to `games/{id}`), Firestore rules for `games` and `usage`, and a "Create a Game / My games" client whose custom runs are isolated from saved progress. Reviewed from the diff `main...HEAD` (7 commits), FEAT-001..004 evidence and the design. Suites were not re-run; counts below come from the FEAT findings.

Watch for: (1) the model id `gemini-3.8-flash` and SDK versions could not be independently checked, only traced to design section 0 (possible); (2) pre-filter refusals cost no quota, so an authenticated caller can loop on them (confirmed, bounded by maxInstances 5); (3) the first live call is untested against real Vertex (confirmed, by design).

**Verdict**: APPROVED

## High-level view

Callable security holds. Identity comes from `request.auth`, role and status are read server-side from `users/{uid}` inside the same transaction that takes the quota and an in-flight lock, and the lock plus both counters are atomic. Only validated classifier fields and the sanitized prompt reach the model, and only validated JSON is stored or returned.

Rules lock `games` to creator or consented adult reads with all client writes denied, and `usage` is fully closed. The games index is added and tested in the emulator.

The mock model is reachable only when `FUNCTIONS_EMULATOR === "true" && MQ_MOCK_MODEL === "1"`; `K_SERVICE` is not referenced outside tests. No secrets, `node_modules` or log files are tracked; the only env file is the non-secret `functions/.env.demo-mathquest`.

The client renders every model string through `textContent`/`createElement`. A custom run writes the pre-run snapshot in `persistProgress`, so level, best, gems and the leaderboard row do not move. `hideAllOverlays` includes both new overlays and the offline path degrades to a "workshop closed" message.

<details>
<summary>Issues (5)</summary>

1. **Free pre-filter loop** (LOW, confirmed) - pre-filter refusals return before `quota.reserve`, so a signed-in caller can send unlimited refused prompts. Cost is a bare invocation, bounded by maxInstances 5; consider a cheap counter later.
2. **Model id and SDK versions unverified by reviewer** (LOW, possible) - `gemini-3.8-flash`, firebase-functions 7.4.0, firebase-admin 14.5.0, @google/genai 3.0.0 rely on design section 0 and `npm ci`. Owner confirms the model id in Vertex Model Garden before deploy (first smoke test covers it).
3. **Real Vertex path never executed** (LOW, confirmed) - `model.js`, production cors/serviceAccount and the 80 s/25 s timing are traced only. The smoke test in the checklist is the first real exercise.
4. **Unrelated deletion of `ctx.shadowBlur = 0;`** (NIT, confirmed) - in the rainbow gem draw; harmless because the draw sits inside `ctx.save()/restore()`, but restore the line to keep the diff scoped.
5. **Local UI test note** (NIT, likely) - `?mqEmulator=1` points only Functions at the emulator while Auth/Firestore stay live; the README says so, but `npm run test:e2e` omits `MQ_MOCK_MODEL=1` (tests skip safely, the emulated function would use the real client if called).

</details>

<details>
<summary>Details</summary>

### Quota, role gate and lock in one transaction

`reserve` reads the caller's `users` doc, the per-user `usage/{uid}_{day}` doc and `usage/global_{day}` in one transaction. It rejects unknown roles, non-active students, a live lock, the per-user limit (student 10, adult 25) and the global cap (1000), then increments both counters and sets a 120 s lock. `finish` is a second transaction that creates the game (`tx.create`) and updates counters together, so a saved game and its counters cannot diverge. Failures refund the user counter up to 3 per day; the global counter is never refunded. If `finish` itself fails after a model failure the lock simply expires. Roles are self-chosen at signup, so the role gate is not a cost control by itself (design Decision 1); the global cap and per-account limits are.

### Prompt path and output validation

The model receives the sanitized prompt and grade hint for classify, then only validated classifier fields for generate. Output passes `validateGame` (count bounds, option counts, forbidden characters, URL/phone patterns, reading level) and results are stored with the sanitized prompt. Logs carry ids, codes and counts, not prompt or model text. A safety block never retries; two generate blocks return a refusal.

### Rules

`games`: get/list for the creator or an adult with an accepted/approved link; create/update/delete false. `usage`: all false. The adult list query pinned by `createdBy` was confirmed in the emulator (G15). The index exists in `firestore.indexes.json`; index enforcement exists only on live Firestore, so the client's `failed-precondition` fallback is untested.

### Custom run isolation

`persistProgress` substitutes `customRun.base` for level, best and gems, and skips the best-score update. `endCustomRun` resets lives and milestones before `updateHUD` so leftover lives cannot re-award gems (bug found and fixed by the isolation test). Entry points `enterGame`, `logout` and `startBtn` all end the run. Mid-run navigation to Create/My games leaves the run flagged but writes stay frozen until a regular Play.

</details>

<details>
<summary>File map</summary>

- `functions/index.js`: onCall options, mock guard, lazy model
- `functions/lib/handler.js`: orchestration, error mapping
- `functions/lib/quota.js`: reserve/finish transactions
- `functions/lib/model.js`, `mock-model.js`: Vertex wrapper and emulator mock
- `functions/lib/prefilter.js`, `validate.js`, `prompts.js`, `config.js`: pure modules
- `functions/test/*`: unit, handler, e2e, client harness
- `firestore.rules`, `firestore.indexes.json`, `rules-test/*`: games/usage rules, index, 16 new tests
- `firebase.json`, `.gitignore`, `functions/package*.json`, `functions/.env.demo-mathquest`: config
- `index.html`: overlays, cloud glue, MQ-CUSTOM region, isolation
- `functions/README.md`, `README.md`, `.agents/design/phase2-steam-agent.md`: docs

Full diff: `git diff main...HEAD`.

</details>

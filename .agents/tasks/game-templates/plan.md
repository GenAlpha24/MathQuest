# Implementation Plan: Phase 3 game templates and pictorial visuals

Source: `.agents/design/phase3-templates-and-visuals.md` (approved), brief `.agents/tasks/game-templates/brief.md`. Branch `feature/game-templates` (HEAD f053adc). Local commits only, never push/deploy. Do NOT commit `.kiro/`, `functions/.env.mathquest-ca395`, `.agents/tasks/`, node_modules, logs, screenshots. Stage files by name.

Decomposition: six sequential features (FEAT-001..006), each leaves the build green and ends with a local commit. Order is by dependency: server schema first (client tests seed v2 docs), then renderer (templates and battle use it), then template framework, then remaining templates, then Create-a-Game UX, then docs, visual check, fixes.

- [ ] 1. FEAT-001 Server: schema v2, visuals validator, templates, prompts, mock, tests.
      New `functions/lib/visuals.js` (LIMITS, KINDS, validateVisual, computeAnswer/matchesAnswer, EMOJI_DENY) and `functions/lib/templates.js` (TEMPLATES, schemaFor, chooseTemplate, COUNTS). Edit `config.js`, `validate.js` (validateGame dispatch, new FIX_CODES, classification keys template/fits/visualKinds), `prompts.js` (PROMPT_VERSION 2, family prompts, VISUAL_DOC), `handler.js` (template arg, recent types query, allowedKinds, 400 degrade, doc fields schemaVersion/type/templateSource/promptVersion, templateNote), `mock-model.js` (trigger words in design 5.10), tests in `functions/test/unit.test.js` and `handler.test.js`. No change to index.js, model.js, quota.js, rules, indexes. Default args must reproduce v1 behavior.
      Commits: (a) `feat(functions): visuals validator and template catalogue`, (b) `feat(functions): schema v2 prompts, handler and mock model`, tests in the same commits as their code.
      Verify: `node --test functions/test/unit.test.js` (>= 282 plus new, all pass); `firebase emulators:exec --only auth,firestore --project demo-mathquest "node --test functions/test/handler.test.js"` (>= 29 plus new pass).

- [ ] 2. FEAT-002 Client visual renderer (`/* MQ-VISUALS */` region in `index.html`) plus `functions/test/visuals.test.js` (jsdom).
      Insert region before the "CREATE A GAME / MY GAMES" banner: VIS_LIMITS, EMOJI_DENY, sanitizeVisual, describeVisual, renderVisual and 8 drawers. Add parity test with server LIMITS/EMOJI_DENY. Wire `#battleVisual` into `#battle` and `loadQuestion`/`makeQuestion` so the runner quiz shows visuals. Check whether jsdom is already a devDependency in functions/package.json; if not, add the pinned version (justify in commit) and run `npm ci`.
      Commit: `feat(client): svg visual renderer`.
      Verify: `node --test functions/test/visuals.test.js` passes; `node --test functions/test/unit.test.js` still passes (parity test).

- [ ] 3. FEAT-003 Template framework + picturequiz + catch.
      `<div id="tpl" class="overlay">` in `el` map and `hideAllOverlays()` (calls `tplTeardown()` first); `/* MQ-TEMPLATES */` region after MQ-CUSTOM:END: TEMPLATE_META, shared helpers (h, btn, setLive, results, reduceMotion, tplLater/tplFrame/tplOn, showVisual), mount for picturequiz and catch; `adaptGame` returns `type` and per-question visual (drop questions with malformed visual, minimum 3); `startCustomGame` routes non-quiz to `mountTemplate`; first statement `if (state === "template") return;` in the global keydown handler; CSS block `/* Templates (Phase 3) */` with reduced-motion media query; COPY additions. Tests: new `functions/test/templates.test.js` plus extend `client.test.js` (key handler, isolation of saveProfile, v1 still plays, forbidden-identifier source scan).
      Commit: `feat(client): template framework, Picture Pick and Bubble Pop`.
      Verify: `node --test functions/test/templates.test.js`; `$env:MQ_MOCK_MODEL='1'; firebase emulators:exec --only auth,firestore,functions --project demo-mathquest "node --test functions/test/e2e.test.js functions/test/client.test.js"` (clear variable afterward).

- [ ] 4. FEAT-004 Remaining templates: memory, sequence, sort.
      Add `adaptTemplateGame` for the three families and their mount modules in MQ-TEMPLATES (two-flip state machine, tap-to-place tiles with Check, queue-based bins), roving keys, stars math, COPY. Tests added to `templates.test.js` (win/lose, stars, hint, replay, keyboard, teardown with fake timers) and `client.test.js`.
      Commits: `feat(client): Memory Match`, `feat(client): Order It and Sort It` (or one commit if tightly coupled).
      Verify: `node --test functions/test/templates.test.js` and the e2e+client command above.

- [ ] 5. FEAT-005 Create-a-Game UX, preview, My games.
      `#cgTemplates` radiogroup chips (Surprise me default) after `#cgChips`; `#cgPreviewTpl`, `#cgPreviewVisual` in `#cgPreview`; module-block `generateGame({prompt, grade, template})` forwarding; `setCgBusy` disables chips; `templateNote === "fallback"` copy; My games rows show template icon and count unit (unknown type -> runner icon). Update the `client.test.js` bridge. E2E cases per template and per visual kind via mock trigger words, override, fallback, variety, v1 docs seeded directly.
      Commit: `feat(client): template chooser, preview and My games icons`.
      Verify: e2e+client command; all pass.

- [ ] 6. FEAT-006 Docs, visual check, fixes, full regression.
      Update `functions/README.md` (schema v2, templates, visuals, tuning knobs VARIETY_WINDOW, counts, mock triggers, deploy order, compat). Visual check: install playwright under `$env:TEMP` (outside repo), serve a throwaway copy of index.html with a test hook from a temp folder, screenshot each template and each of 8 visual kinds at 1280 and 360 px into `$env:TEMP`, describe what was seen, fix layout bugs in index.html, re-screenshot. If no headless browser runs, state "rendering NOT visually verified". Run all four suites. Check ports 8080, 9099, 5001, 4400, 4500, 9150 free before emulators; no emulator left running.
      Commits: `docs: functions README for schema v2`, `fix(client): visual check findings`.
      Verify: unit, handler, e2e+client, rules suites all green; `git status` clean except the ignored untracked items.

## Digest

- `functions/lib/validate.js` (11.6 KB): `validateGame`, `FIX_CODES`, classification validator; covered by `unit.test.js`. Today: 282 unit tests pass (per brief, not re-run by planner).
- `functions/lib/prompts.js`: `PROMPT_VERSION`, `CLASSIFY_SYSTEM`, `GENERATE_SYSTEM`, schema builders using `responseSchema` with `SUPPORTED_SCHEMA_FIELDS` guard; covered by unit tests.
- `functions/lib/handler.js`: `handleGenerate`, `parseArgs`, `canRetry`; covered by `handler.test.js` (29 pass per brief).
- `functions/lib/mock-model.js`: trigger-word mock; used by e2e.
- `index.html` (4968 lines): anchors per design 6.1 (`createGame`, `myGames`, `battle`, `const el = {`, `hideAllOverlays`, MQ-CUSTOM region, keydown handler, `sfx`). Line numbers drift; use anchor text.
- Tests: `functions/test/{unit,handler,e2e,client}.test.js` exist; `visuals.test.js` and `templates.test.js` are new.
- Baseline from brief (not re-run by planner): unit 282, handler 29, e2e+client 26, rules 69. Rules tests unchanged (`rules-test/rules.test.js`).
- Repo state checked: branch feature/game-templates, untracked `.kiro/`, `functions/.env.mathquest-ca395`, `.agents/tasks/game-templates/`; none may be committed.

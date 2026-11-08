# Design review: phase3-templates-and-visuals.md (iteration 2 re-review)

Verdict: APPROVED (0 HIGH, 0 MEDIUM, 3 NIT).

## Prior findings (iteration 1, 3 MEDIUM + 4 NIT)

| # | Prior finding | Status |
|---|---------------|--------|
| 1 | MEDIUM: picture-dependent questions possible without a picture (legacy / degraded) | Closed. 5.8 forces `allowedKinds = []` for legacy and 400-degrade; 5.6 makes paragraph B and `VISUAL_DOC` conditional; degraded `picturequiz` is text-only; handler tests listed. |
| 2 | MEDIUM: 4.3 contradiction (null visual vs play) | Closed. `adaptGame` drops any item whose `visual` fails sanitize, minimums return `null`, draw-time failure is skipped without penalty. |
| 3 | MEDIUM: global keydown handler preventDefaults Space/ArrowUp | Closed. Anchor is real (index.html:3426-3428, first statement is the Space/ArrowUp preventDefault); 6.3 puts `if (state === "template") return;` first; test planned. `state` is a plain string variable (line 1387), canvas `mousedown`/`touchstart` call `jump()` which is state-guarded. |
| 4-7 | NITs (null template, shadedFraction, sfx mapping, answerCheck sub-schema) | Closed. Specified in 5.2, 4.4, 6.4. |

## Findings (new)

1. NIT (4.4): numeric `answerCheck` matching says "parse the first integer in the option". Thermometer ranges go to -30, so the parse must be signed (`/-?\d+/`), otherwise "-5" and "5" both match and the question is rejected as ambiguous. Fix: state the regex as `/-?\d+/` and add a unit case.
2. NIT (6.4): the sfx line numbers are off by one (`const sfx = {` is 1554, `jump` 1555, `correct` 1557, `wrong` 1558). The doc already says line numbers drift and the anchor text is the contract. Fix: fix the numbers or drop them.
3. NIT (6.6): the client `generateGame` in the module block returns `{ ok, game, remaining }` and drops other fields. For `templateNote` to reach the UI it must also be returned (`templateNote: d.templateNote || null`). 6.6 only says `template` is forwarded. Fix: add one sentence to 6.1/6.6.

None of these blocks.

## Verified Assumptions (checked against source)

- Index.html anchors exist: `#createGame` 487, `#cgChips` 493, `#myGames` 517, `#homeCreate` 532, `#battle` 573, `#graphCanvas` 580, `generateGame` 1190, `listMyGames` 1204, `const el = {` 1244, `const sfx` 1554, `tone` 1534, `playSolo` 1887, `MQ-CUSTOM:BEGIN/END` 2041/2168, `persistProgress` 2293, `makeQuestion` 2769, `loadQuestion` 2896, global keydown 3426, `hideAllOverlays` 3632 with the overlay array ending `el.createGame, el.myGames`. Per-input `stopPropagation` workarounds exist at the cited places.
- `listMyGames` spreads whole docs (`...d.data()`), so `type` reaches My games without a client query change.
- Repo helpers named in the design exist in `validate.js`: `FIX_CODES`, `CLASSIFICATION_KEYS`, `EMOJI_RE`, `normKey`, `optionTooHard`, `textTooHard`, `checkText`, `GAME_MAX_BYTES` 65536; `prompts.js` has `PROMPT_VERSION = 1`, `SUPPORTED_SCHEMA_FIELDS`, numeric `minItems/maxItems` already in use. `handler.js` `parseArgs` ignores unknown fields and `canRetry` budget is as described.
- `validateClassification` rejects unknown keys, so adding `template/fits/visualKinds` to `CLASSIFICATION_KEYS` is required and specified.
- `firestore.indexes.json` has `games (createdBy ASC, createdAt DESC)`; `firestore.rules` games block has no field-level checks, so no rules or index change is needed.
- `jsdom` 31.0.0 is already a functions devDependency, and `client.test.js` already loads index.html into jsdom with a hook after `MQ-CUSTOM:END`, so the planned renderer/template tests fit the harness; Playwright is planned outside the repo.
- Security: model supplies only enums, bounded integers and short plain strings; render path is createElementNS/setAttribute(number or constant)/textContent only; type is server-set; unknown types and schemaVersion > 2 yield null; prototype keys handled by allowlist rebuild; stored visual and doc sizes bounded (2 KB per visual, 15 visuals, 64 KB doc).
- Back-compat both directions is specified (legacy client forces `quiz` with no visual; v1 docs play as `quiz`; new client against old server gets v1).
- Cost/DoS: token estimates sit under the unchanged 16384 cap, quota and timeouts unchanged, schemas built small per request with a complexity-cap test.
- All six owner decisions are stated with a recommendation and rejected alternatives (section 1 table, section 13).
- Imagen evaluation (section 12) is honest: cost/latency, safety, unverifiable correctness, consistency, storage surface; recommends against.

## Unverified / Wrong Assumptions

- Not verifiable here and disclosed by the design: Vertex acceptance of the per-request schemas, `minItems/maxItems` typed as numbers while the d.ts types them as strings, real model quality, pie/pizza art quality, token figures. Mitigations (400 degrade, complexity test, owner smoke test, Playwright pass) are adequate for the design stage.
- Line numbers for the sfx entries are off by one (NIT 2); no other anchor was wrong.

# Design review: phase2-steam-agent.md (revision 2)

Verdict: APPROVED (0 HIGH, 0 MEDIUM, 2 NIT)

## Prior findings (review 1)

1. HIGH, mock guard used `!K_SERVICE`: **Closed**. The design now uses `FUNCTIONS_EMULATOR === "true" && MQ_MOCK_MODEL === "1"` in the section 1 `index.js` sketch, the threat-model row, and the 9d guard assertion. I re-checked the installed firebase-tools `functionsEmulator.js`: line 1011 sets `K_SERVICE = trigger.name` for every trigger and line 1017 sets `FUNCTIONS_EMULATOR = "true"`, so the new two-part guard can enable under the emulator. No `K_SERVICE` check remains except as a "do not use" note and a test assertion.
2. NIT, grade authority: **Closed**. 4.3 and 5.1 now agree (named grade wins only within 2 steps of the selector hint).
3. NIT, empty section 14: **Closed**. Section 14 lists the three responses.

## New findings

1. NIT. Section 1 `index.js` sketch imports `params` from `firebase-functions`, but the text says `MQ_VERTEX_LOCATION` is declared with `defineString`. That function lives in `firebase-functions/params`. Fix: `const { defineString } = require("firebase-functions/params");`.
2. NIT. Section 7.1 anchor 3 cites lines "448-449" and anchor 16 cites `makeQuestion` at 2343. In the current file `makeQuestion` is at line 2343 and its return is 2344; the 24 anchor texts are real. The design already says the anchor text is the contract, so no change is needed beyond tidying the numbers.

## Verified assumptions

- Callable security: identity comes from the verified token. Role and status are read server-side inside the `reserve` transaction from `users/{uid}`. A missing or role-less doc is denied (`profile`) and a non-active student is denied (`pending`). Nothing role-related is trusted from the request.
- Quota atomicity: one Admin transaction covers per-user and global counters plus the `lockUntil` in-flight lock. `finish` writes the game and usage together. `usage` is deny-all in rules. Refunds are capped per user and never refunded globally.
- Output safety: the model output is validated by a pure `validateGame` and stored only in normalized form. The client renders with `textContent`. `games` writes are `false` for clients. Prompt-injection handling is layered (system prompt separated, JSON-encoded data field, generator never sees raw text).
- Rules diff against the real `firestore.rules`: `signedIn()` and `adultLinkedTo()` exist and are in scope. Placement before `users` is valid. `existing()` is `resource.data`, so it works for `get` and `list`. Call count is within limits. A17-A21 follow A16. A list-query uncertainty has a defined fallback. The new `games` index is consistent with the existing `firestore.indexes.json` format.
- index.html anchors confirmed present in the current file: L198 `.link-code-box b`, L345 `invitesBtn`, L606 firestore import, L644 `LEADERBOARD`, L1155 `approvalDesk`, L1261 `let subject`, L1540 `enterGame`, L1837 `logout`, L1875-1878 `persistProgress`, L2344 `Questions.make(subject...`, L2462 `battleQuestionsNeeded`, L2560/2626/2638 `setTimeout(loadQuestion, 900)`, L2619 `endBattle`, L2779 hint, L2786 videoTopic, L2953 keydown, L3039 `inviteInput` keydown, L3132 `hideAllOverlays` array.
- Version and model facts: `@google/genai` 3.0.0, `firebase-functions` 7.4.0, `firebase-admin` 14.5.0, `jsdom` 31.0.0 (npm view, first review). The Gemini 3.8 Flash docs page exists. The host clock is 2026-11-06, matching the design.
- All 10 decisions have a recommendation, justification and alternatives (or a pointer to a full section), with veto flags on 1, 3, 4 and 7.

## Unverified assumptions

- I did not independently re-read the Node 24 GA runtime table, the Vertex safety-filter default (OFF for 3.5 and later), or the `ThinkingLevel`, `retryOptions.attempts` and `abortSignal` names in `@google/genai` 3.0.0. The design tells the implementer to confirm these against `genai.d.ts`, and it declares pricing, data handling and token accounting as unverified. That is acceptable for a design.
- The adult `list` query being accepted by the emulator is untested. The design gives a defined fallback and a test plan for both outcomes.

# functions: STEAM game builder (`generateGame`)

Cloud Functions 2nd gen callable that turns a child's idea into a validated STEAM game (Gemini on Vertex AI). The game is one of six templates and may carry declarative pictures. The client only ever receives JSON game definitions, never code, markup or URLs.

## Run and test (emulators only, no live project)
Needs Node, the Firebase CLI and Java 21. Run from the repo root. Use `firebase.cmd` if PowerShell blocks `firebase.ps1`.
```
cd functions; npm ci; cd ..
node --test functions/test/unit.test.js
firebase emulators:exec --only auth,firestore --project demo-mathquest "node --test functions/test/handler.test.js"
$env:MQ_MOCK_MODEL='1'; firebase emulators:exec --only auth,firestore,functions --project demo-mathquest "node --test functions/test/e2e.test.js functions/test/client.test.js"
firebase emulators:exec --only firestore --project demo-mathquest "node --test rules-test/rules.test.js"
```
`MQ_MOCK_MODEL=1` only works inside the Functions emulator (`index.js` checks `FUNCTIONS_EMULATOR` too). Never use `firebase` commands against `mathquest-ca395` except the deploy steps below.

## Owner deploy checklist (the agent runs none of this)
One-time prerequisites:
1. Blaze plan on `mathquest-ca395` (approved).
2. Enable APIs: `gcloud services enable aiplatform.googleapis.com cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project mathquest-ca395` (or console, APIs & Services).
3. Service account `mq-game-builder` (used by `serviceAccount: "mq-game-builder"` in `index.js`). Grant it `roles/aiplatform.user`, `roles/datastore.user` and `roles/logging.logWriter`. Grant the deploying user `roles/iam.serviceAccountUser` on it. Fallback (broader, not recommended): drop the `serviceAccount` option and give the default compute service account `roles/aiplatform.user`.
4. Budget alert: Billing > Budgets & alerts, alert at 50/90/100 percent of a small monthly amount. Optional: Firestore TTL policies on `games.expireAt` and `usage.expireAt` (console, Firestore > TTL).
5. Model location: default `us`. To change, create `functions/.env.mathquest-ca395` with `MQ_VERTEX_LOCATION=global`.

Deploy order (rules and functions first, client last):
1. `cd functions; npm ci; cd ..`
2. `firebase deploy --only firestore:rules,firestore:indexes --project mathquest-ca395`
3. `firebase deploy --only functions --project mathquest-ca395` (the first deploy may prompt to enable APIs or set an Artifact Registry cleanup policy)
4. Merge the PR so GitHub Pages publishes the client. The new menu entries call a function that must already exist. Old client + new server is safe (no 	emplate field, so the server returns a plain quiz with no pictures). New client + old server is safe (the old server ignores 	emplate and returns a v1 quiz).
5. Live smoke test with your own adult account: build one game, check `games/{id}` in the console, check that "tell me a joke" is refused with the friendly copy, and check Cloud Logging has no prompt text.

Manual checks after deploy: adult and active student can create a game; a pending student gets the "ask a parent or teacher" message; off-topic and personal-info prompts are refused; the 11th student attempt of the day shows the daily limit; replay from "My games" makes no model call; level, best and the leaderboard row do not change after a custom run; billing shows Vertex usage inside the budget.

## Rollback
- Client: revert the merge commit (Pages rebuilds).
- Function: `firebase functions:delete generateGame --region us-central1 --project mathquest-ca395`, or redeploy the previous commit.
- Rules and indexes: redeploy the previous `firestore.rules`. The new collections become unreadable; saved games stay in Firestore.
- Stop spend right away: set `GLOBAL_DAILY` to 0 in `lib/config.js` and redeploy functions, or disable the Vertex AI API.

## Model deprecation
The model id lives in one place: `MODEL_ID` in `lib/config.js` (a unit test enforces a single occurrence). To change it: edit that constant, run the four test commands above, deploy functions. Check the Vertex AI model lifecycle page before a model's retirement date.

## App Check (optional hardening, off by default)
Register the site with reCAPTCHA Enterprise in the console (App Check), add the App Check SDK to `index.html`, watch the metrics for a few days, then set `enforceAppCheck: true` in `index.js` and redeploy functions. Enforcing before real traffic is verified would block your own players.

## Windows quirks
Run everything from the repo root. Set `$env:PATH` to include Java 21 for the emulators. Node here is v26 while `engines` says 24, so the CLI warns and uses the host Node locally; deploys use the declared runtime. Do not add a `predeploy` npm hook. Deploy output is often swallowed, so verify with `firebase functions:list --project mathquest-ca395`.

## Local UI test
Serve the repo on localhost, start the Auth, Firestore and Functions emulators, and open the page with `?mqEmulator=1`. That flag only points the Functions client at `127.0.0.1:5001` on localhost; the Firestore and Auth clients in the page still talk to the live project, so use it only to check the callable wiring.

## Schema v2: templates and pictures
Request: `{ prompt, grade?, count?, template? }`. `template` absent = legacy client (server forces `quiz`, no pictures); `"auto"` or one of the ids below; anything else is `invalid-argument`. `count` (5-15) applies only to the choice family. The response adds `templateNote` (`"fallback"` when the chosen template did not fit, else `null`). Stored docs carry `schemaVersion: 2`, `type`, `templateSource` (`auto|user|fallback|variety`), `promptVersion: 2`. Docs without `schemaVersion` are v1 and play as `quiz`.

| type | payload field | size (`config.js`) | notes |
|------|---------------|--------------------|-------|
| `quiz` (Monster Run) | `questions` | 5-15 (default 8) | unchanged runner |
| `picturequiz` (Picture Pick) | `questions` | 5-15 | picture or emoji per question |
| `catch` (Bubble Pop) | `questions` | 5-15 | short options |
| `memory` (Memory Match) | `pairs` (`a`, `b` sides) | 4-6 pairs | every side label distinct |
| `sequence` (Order It) | `rounds` with `steps` stored in correct order | 3-5 rounds x 3-5 steps | client shuffles |
| `sort` (Sort It) | `bins` + `items` (`bin` index) | 8-12 items, 2-3 bins | every bin used |

`questionCount` always means playable items (questions, pairs, rounds or items).

Visual kinds (flat `visual` object, `kind` picks the legal keys; all limits live in `LIMITS` in `lib/visuals.js`, with a parity copy in `index.html` checked by a test): `barChart` (2-8 bars, values 0-100), `pie` (2-12 parts, themes pizza/pie/chocolate/plain), `numberLine` (step in {1,2,5,10,20,25,50,100}, at most 20 steps, up to 3 marks), `clock`, `shape` (six shapes, optional side labels and split), `emojiGroup` (1-30), `pictograph` (2-6 rows, at most 40 symbols), `thermometer`. Memory cards, sort items and sequence steps accept only the compact kinds (`pie, emojiGroup, clock, shape, thermometer`). At most 15 visuals per game and 2 KB of visual JSON each. The model never supplies SVG, HTML, CSS or URLs; the client draws the pictures and builds the screen-reader text from validated numbers.

`answerCheck` (choice family, optional): the model names an operation (for example `maxLabel`, `shadedFraction`, `sum`, `remaining`, `time`, `perimeter`) and the server computes the answer from the validated picture; exactly one option must match and it must be `correctIndex`, else fix code `visual_mismatch`, one retry, then `gen_failed` and refund. Honest limits: it is a model assertion. It catches wrong arithmetic or misreading of the picture, but cannot tell that the question really asks what the op computes, that the wrong options make sense, or anything about questions without `answerCheck`. Sequence order, sort membership and memory pair truth are model-asserted and not machine-checked.

## Tuning knobs (`lib/config.js`)
- `VARIETY_WINDOW` (3): if the user's last N games all used the template `auto` would pick and another template fits, the next one is used.
- Counts: `MIN_QUESTIONS/MAX_QUESTIONS/DEFAULT_QUESTIONS`, `MEMORY_*`, `SEQUENCE_*`, `SORT_*`.
- `GENERATE_MAX_OUTPUT_TOKENS` (16384) and the timeouts are unchanged from Phase 2; quotas are unchanged. Estimated output is 500-1200 tokens per game without pictures and up to about 4500 for 15 picture questions (estimates, replace with the `outTokens` log values after live runs).
- If the Vertex schema is rejected (HTTP 400), attempt 2 falls back to a text-only game (log `gen_degraded`).

## Mock model trigger words (emulators only)
Put these in the prompt when `MQ_MOCK_MODEL=1`:
- Template: `mockmemory mocksequence mocksort mockcatch mockpicture mockquiz` (none = quiz).
- Pictures (up to 2): `mockbar mockpie mockline mockclock mockshape mockemoji mockpicto mockthermo`.
- Failures: `mockbadvisual mockmismatch mockdupcards mockbadsort mockschema400 mockfallback`, plus the Phase 2 words `mockinvalidonce mockinvalidtwice mockblocked mockofftopic`.

## Rollback (schema v2 additions)
Redeploy the previous functions revision, and revert the client merge at the same time: v2 games already saved are only playable by the new client. v1 games stay playable either way.
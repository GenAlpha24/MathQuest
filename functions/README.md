# functions: STEAM game builder (`generateGame`)

Cloud Functions 2nd gen callable that turns a child's idea into a validated multiple-choice STEAM quiz (Gemini on Vertex AI). The client only ever receives JSON game definitions, never code.

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
4. Merge the PR so GitHub Pages publishes the client. The new menu entries call a function that must already exist; an older client against the new backend has no effect.
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

# Phase 1 Design — Three-Role Identity + Cross-Role Authorization

Status: DRAFT for review • Branch: `feature/roles-and-authorization` • Scope: Phase 1 only (identity + authorization). AI agents / game builder are later phases.

## 1. Overview

MathQuest today is a single-file static app (`index.html`, ~3439 lines) served from GitHub Pages, with a `<script type="module">` block that wires Firebase v10.12.2 (Auth email/password + Firestore) and exposes `window.MathQuestCloud`. Firestore holds two collections: `users/{uid}` (per-player profile) and `usernames/{userid}` (unique userid → `{uid, email}` for userid-based login). If Firebase init fails, the game runs fully offline from a per-UID local cache.

Phase 1 layers a three-role identity model (`student`, `teacher`, `parent`) and a cross-role authorization flow onto this setup **without a build step, without a framework, and without breaking the offline fallback**. A newly signed-up student is PENDING and cannot appear on global leaderboards or be assigned work until a linked parent or teacher approves them. Students can still play solo immediately so the app is never a dead end for a kid waiting on an adult.

The technology stack is **locked** for this phase: plain HTML/CSS/vanilla-JS, Firebase Web SDK v10.12.2 loaded from the gstatic CDN as ES modules (same versions already imported), Firebase Auth (email/password), Cloud Firestore, and a new `firestore.rules` file. No bundler, no npm runtime dependency, no framework. No Cloud Functions in Phase 1 (but the model must not block adding Functions + Vertex AI Gemini later).

## 2. Role Model

Every account has exactly one `role`, chosen once at signup and stored on `users/{uid}`:

- **student** — plays the runner; later creates games/puzzles. On signup `status = 'pending'`. A pending student can play solo (offline-style) but is excluded from global leaderboards and cannot be assigned work. After a linked adult approves, `status = 'active'`.
- **teacher** — an adult. Can see students who have linked to them and approve/deny those links. Teachers and parents are functionally identical in Phase 1 authorization power; the distinction is for later features (classes vs. family) and reporting.
- **parent** — an adult, same authorization capability as teacher.

Roles are **not** a privilege ladder a user can climb. `role` is write-once at document creation and immutable thereafter (enforced in security rules, §6). There is no "admin" role in Phase 1.

Adults (`teacher`/`parent`) are `active` the moment they sign up — they are not gated. Only students carry a `status` lifecycle. Adult docs may omit `status` or set it to `'active'`; rules treat a missing `status` on a non-student as fine.

## 3. Authorization / Linking Mechanism — DECISION (human can veto)

Three candidate mechanisms were considered:

- **(A) Adult-code claim.** Each adult has a short human-readable `linkCode` (e.g. `SUN-42KQ`). The student (or the adult sitting with them) types the code to create a pending link; the adult then approves it from their approval list. Simple mental model, matches the existing "type a short thing" UX, and a code can be printed on a classroom board or texted to a parent.
- **(B) Adult-initiated invite by userid/email.** The adult enters the student's `userid` (or email) to create a pending link the student accepts. Reverses initiative to the adult.
- **(C) Pure pending-approval queue keyed on a shared class/family id.** Student joins a group by id; adult approves from the group queue. Heaviest — needs a groups collection and membership semantics we do not need yet.

**DECISION (recommended): (A) Adult-code claim, plus a thin slice of (B) as a fallback.** Rationale:

- It fits the existing userid-first, "type a short code" interaction and the kid-friendly tone. A child can act without knowing their own email, and an adult can hand out one code to a whole class or one family.
- It keeps the student in control of initiating the link (they already just typed a userid/password), and keeps final authority with the adult (approval is still an explicit adult action). A code alone never activates a student — approval is a separate adult step, so a leaked code cannot auto-approve anyone.
- It needs only one new collection (`links`) plus a `linkCode` field on adult docs — no groups/classes machinery, so it does not over-build for Phase 1 and does not conflict with adding classes later.
- Tradeoff vs. (B): a guessable/short code could let a stranger create a *pending* link to an adult (spam in the adult's queue). Mitigations: codes are random (not sequential), reasonably long (≥6 chars from an unambiguous alphabet), and a pending link grants **zero** capability until the adult approves — the worst case is queue noise the adult declines, never data exposure or activation. Rate-limiting code-claim attempts is deferred to Phase 2 (would want a Cloud Function; out of scope now). This is flagged below as a known limitation.

Approval direction: **the student claims a code → a `pending` link document is created → the adult approves → the adult write flips the student to `active`.** A single approval from any one linked adult is sufficient to activate the student (do not require both a parent and a teacher). Additional adults may still link afterward.

> **VETO POINTS for the human reviewer:** (1) mechanism A vs. B vs. C; (2) "one approval activates" vs. "require a specific adult type"; (3) whether pending-link spam needs rate limiting in Phase 1 (currently deferred).

## 4. Firestore Data Model

### 4.1 `users/{uid}` (extended — existing fields preserved)

Existing fields stay exactly as the current `saveProfile` writes them (`uid, name, email, best, level, grade, speed, heroColor, hairColor, eyeColor, heroHair, heroGender, gemMatchColor, megaGemsCollected, ultraGemsCollected, subject, musicOn, created, updated`). New fields:

```
users/{uid} {
  ...existing profile fields...,
  role:     'student' | 'teacher' | 'parent',   // write-once at signup, immutable
  // students only:
  status:   'pending' | 'active',                // adults: 'active' or absent
  approvedBy: string | null,                      // uid of the adult who activated (audit)
  // adults only (teacher|parent):
  linkCode: string,                               // e.g. "SUN42KQ"; see 4.3
}
```

Legacy docs created before Phase 1 have no `role`. Treated as `role: 'student', status: 'active'` (grandfathered — existing players keep playing and keep their leaderboard spot). The client backfills these fields lazily on next login (§7.4).

### 4.2 `usernames/{userid}` (unchanged shape, one added field)

```
usernames/{userid} { uid: string, email: string, role?: string }
```

`role` is copied here so an adult’s "link a student by userid" fallback (mechanism B) can resolve a userid without reading a `users` doc it is not allowed to read. Optional; can be added at signup only.

### 4.3 `linkCodes/{code}` (new) — adult discovery index

```
linkCodes/{CODE} { adultUid: string, role: 'teacher'|'parent' }
```

Keyed by the uppercase code so a student can resolve a code to an adult uid with a single `getDoc` without being able to list/read adults' `users` docs. Code generation: 7 chars from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits ambiguous `I/O/0/1`). Created at adult signup; collision retried (re-generate if the doc already exists). This is a public-ish lookup table containing no PII (only a uid + role), which is why it is safe to allow authenticated reads.

### 4.4 `links/{linkId}` (new) — the authorization records

One document per (student, adult) relationship. `linkId = "{studentUid}_{adultUid}"` (deterministic → idempotent claims, no duplicate pending links).

```
links/{studentUid_adultUid} {
  studentUid: string,
  adultUid:   string,
  adultRole:  'teacher' | 'parent',
  status:     'pending' | 'approved' | 'denied',
  createdBy:  string,   // uid that created the doc (student in mechanism A)
  createdAt:  timestamp,
  decidedAt:  timestamp | null,
}
```

### 4.5 Lookups / indexes

- Student resolves a code: `getDoc(linkCodes/{CODE})` — key lookup, no index.
- Adult lists their pending/approved students: `query(links, where('adultUid','==',me), where('status','in',['pending','approved']))` — composite index on (`adultUid`, `status`). Declared in `firestore.indexes.json` (committed, not deployed in this phase).
- Adult shows each linked student's name/status: `getDoc(users/{studentUid})` — allowed because a link exists (§6).
- Student checks their own authorization: read their own `users/{uid}.status`.

Global leaderboard query stays `query(users, orderBy('best','desc'), limit)` but Phase 1 adds a client-side (and eventually rules-free) filter: only `status === 'active'` rows render. (A pending student’s `best` is 0 at signup anyway; the filter is belt-and-suspenders and documented so Phase 2 can move it server-side.)

## 5. Offline / Pending-Student Experience

- **Offline (Firebase unavailable):** unchanged. The game already falls back to local cache + local leaderboard. Role/status logic is skipped entirely; the user plays solo exactly as today. No regression.
- **Pending student (online, not yet approved):** after login they land on a **"Waiting for approval"** screen that explains a parent/teacher needs to approve them, shows a **"Have a code? Enter it"** field to claim an adult code, and offers a **"Play solo for now"** button. Playing solo uses the normal game loop but: (a) their score is **not** written to the global leaderboard view (client filter), (b) they are flagged as pending in their profile. When an adult approves, their next login (or a live `onSnapshot` on their own `users/{uid}`) flips them to `active` and they get the full start screen. Pending is never a hard wall.
- **Active student / any adult:** adults go to an **Approval screen** (their linked students with approve/deny buttons) and can still open the game. Active students go straight to the existing start screen.

## 6. Security Rules Strategy (`firestore.rules`) + Attack-Case Reasoning

Rules are the **only** real protection: the Firebase web config (`apiKey`, project id, etc.) is public in `index.html` and cannot be hidden in a static site. Anyone can instantiate the SDK against project `mathquest-ca395`. Therefore every invariant below is enforced server-side in rules, never by trusting the client.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function isSelf(uid) { return signedIn() && request.auth.uid == uid; }
    function incoming() { return request.resource.data; }
    function existing() { return resource.data; }

    // ---- usernames: unique userid -> {uid,email}. Create once; readable so
    //      login can resolve userid->email. Never mutate someone else's.
    match /usernames/{userid} {
      allow read: if true;                         // needed pre-auth for login
      allow create: if isSelf(incoming().uid);     // you can only claim for yourself
      allow update, delete: if false;              // immutable in Phase 1
    }

    // ---- linkCodes: adult discovery table (uid + role only, no PII)
    match /linkCodes/{code} {
      allow read: if signedIn();                   // student resolves a code
      allow create: if isSelf(incoming().adultUid)
                    && incoming().role in ['teacher','parent'];
      allow update, delete: if false;
    }

    // ---- users/{uid}
    match /users/{uid} {
      allow read: if isSelf(uid) || adultLinkedTo(uid);

      // Create own doc. role fixed at creation; students start pending.
      allow create: if isSelf(uid)
        && incoming().role in ['student','teacher','parent']
        && (incoming().role != 'student' || incoming().status == 'pending');

      // Self update: may change profile/progress, but NOT escalate.
      allow update: if isSelf(uid)
        && incoming().role == existing().role              // role immutable
        && incoming().status == existing().status          // can't self-approve
        && incoming().approvedBy == existing().approvedBy; // can't self-set approver

      // Adult approval: a linked adult flips the student to active.
      allow update: if signedIn()
        && existing().role == 'student'
        && approvedLinkExists(uid, request.auth.uid)
        && incoming().status == 'active'
        && incoming().role == existing().role
        && onlyStatusAndApprover(uid);

      allow delete: if false;
    }

    // ---- links/{studentUid_adultUid}
    match /links/{linkId} {
      allow read: if signedIn()
        && (isSelf(existing().studentUid) || isSelf(existing().adultUid));

      // Student creates a PENDING link to an adult (mechanism A).
      allow create: if isSelf(incoming().studentUid)
        && incoming().status == 'pending'
        && incoming().createdBy == request.auth.uid
        && linkId == incoming().studentUid + '_' + incoming().adultUid;

      // Adult decides (approve/deny) on links addressed to them.
      allow update: if isSelf(existing().adultUid)
        && existing().status == 'pending'
        && incoming().status in ['approved','denied']
        && incoming().studentUid == existing().studentUid
        && incoming().adultUid == existing().adultUid;

      allow delete: if false;
    }

    function adultLinkedTo(studentUid) {
      return signedIn() && exists(/databases/$(database)/documents/links/$(studentUid + '_' + request.auth.uid));
    }
    function approvedLinkExists(studentUid, adultUid) {
      let l = get(/databases/$(database)/documents/links/$(studentUid + '_' + adultUid)).data;
      return l.status == 'approved';
    }
    function onlyStatusAndApprover(uid) {
      // every field except status/approvedBy/updated must be unchanged
      return incoming().diff(existing()).affectedKeys().hasOnly(['status','approvedBy','updated']);
    }
  }
}
```

### Attack-case reasoning pass

1. **Student self-approves.** Self-`update` branch requires `incoming().status == existing().status`, so a student can never change their own `status`. The only path to `active` is the adult-approval branch, which requires `approvedLinkExists(student, request.auth.uid)` — i.e. the caller is an adult with an *approved* link. Blocked. ✔
2. **Student reads another user's doc.** `users` read allows `isSelf(uid)` or `adultLinkedTo(uid)`. A student is never "linked as the adult" of another user, so cross-student reads fail. Blocked. ✔
3. **Role escalation at signup.** `create` pins `role in {...}` and forces students to start `pending`. A user could *choose* `teacher` at signup — this is accepted by design in Phase 1 (self-declared adult), and is called out as a known limitation below. They still cannot touch anyone else's data; being a teacher only grants power over students who *claim your code and whom you approve*. ✔ (with noted limitation)
4. **Role escalation on update.** Both self-update and adult-update branches require `incoming().role == existing().role`. `role` is immutable post-creation. Blocked. ✔
5. **Adult activates a student they were never approved for.** Approval branch calls `approvedLinkExists(uid, auth.uid)` which `get()`s `links/{student_adult}` and checks `status == 'approved'`. No approved link → denied. And an adult can only move a link to `approved` on a link whose `adultUid` is themselves. Blocked. ✔
6. **Adult over-writes a student's profile under cover of approval.** `onlyStatusAndApprover` restricts the adult’s diff to `status`/`approvedBy`/`updated`. An adult cannot change a student's score, grade, name, etc. ✔
7. **Spoofing a link to gain read access to a stranger.** `adultLinkedTo` only returns true if a `links/{student_adult}` doc exists, and a student creating that doc can only set `status: 'pending'` with `createdBy == self`. A pending link grants the adult read of the student doc (needed to show the name in the approval queue) but **no write power** until the adult approves — and the adult cannot approve a link whose student did not create it. Residual: a student can expose their own doc to any adult uid by linking; acceptable (it's the student's own data and the intended flow). ✔
8. **Queue spam via guessed codes.** A stranger who guesses an adult's code can create a *pending* link (queue noise). It grants zero capability and the adult declines it. Rate-limiting deferred (needs a Function). Documented limitation. ⚠

### Known limitations (explicit, for reviewer)

- **Self-declared adult role at signup.** Phase 1 has no verification that a "teacher"/"parent" is really an adult. This is standard for an MVP and bounded (an adult only gains power over students who opt in by claiming their code). Real verification (email domain, invite tokens, admin) is a later phase.
- **No code-claim rate limiting** (queue spam). Needs a Cloud Function — deferred to keep Phase 1 build-free.
- **Leaderboard pending-exclusion is client-side** in Phase 1. A determined pending user could read the raw `users` query. Moving exclusion server-side needs either a denormalized `leaderboard` collection or a Function; deferred and documented.

## 7. Client Changes in `index.html` (exact regions)

All edits stay inline / in the existing module; no new files loaded in the browser except Firebase (already loaded). Line numbers are current-state anchors (file is 3439 lines).

### 7.1 Firebase module block (`<script type="module">`, ~lines 510–700)
- Add collection constants `LINKS = "links"`, `LINKCODES = "linkCodes"` beside the existing `USERS`/`USERNAMES` (~line 566).
- Extend `signup(...)` (~lines 606–651) to accept `role`. Validate `role in {student,teacher,parent}`. On student signup write `status:'pending', approvedBy:null`. On adult signup generate a unique `linkCode`, write `linkCodes/{code}`, and store `linkCode` + `role` on the `users` doc. Also write `role` into the `usernames/{id}` mapping.
- Extend `onAuthChange` callback payload (~lines 576–585) to also surface `role`/`status` by reading the profile (or let `enterGame` read it — see 7.3; keep the listener thin).
- Add new `MathQuestCloud` methods: `claimCode({code})` (student creates pending link via `linkCodes` lookup + `links` setDoc), `listLinkedStudents()` (adult query on `links`), `approveStudent({studentUid})` / `denyStudent({studentUid})` (adult updates `links` then, on approve, updates `users/{studentUid}.status`), `watchMyStatus(cb)` (optional `onSnapshot` on own `users` doc for live approval), and `myLinkCode()` getter for adults. Import `updateDoc`, `where`, `onSnapshot`, `deleteField` as needed from the already-used firestore module URL.

### 7.2 Auth UI HTML (`#auth` overlay, lines 342–367)
- Add a **role picker** to the Sign Up pane (`#signupPane`, lines 358–364): three selectable buttons (I'm a Student / Parent / Teacher) styled with the existing `.grade-btn`/`.color-swatch` pattern and pastel palette. Default = Student.
- Add two new overlays after `#auth` (sibling `<div class="overlay">` blocks, inserted around line 367): `#pendingApproval` (waiting screen: explanation, "Enter adult code" input + button, "Play solo for now" button) and `#approvalDesk` (adult screen: your link code displayed, list of pending/approved students with Approve/Deny buttons, "Open game" button).
- Reuse existing CSS classes (`.overlay`, `.btn`, `.btn.big`, `.auth-hint`, `.grade-btn`). Add a small `.role-btn`/`.student-row` CSS block in the `/* Auth */` CSS region (~lines 151–171) matching the rounded-card pastel style.

### 7.3 Auth flow JS (functions ~lines 1052–1175)
- `doSignup` (~1072): read the selected role, pass it to `cloud().signup`.
- `enterGame` (~1104): after loading the profile, branch on `role`/`status`: adult → render & show `#approvalDesk`; pending student → render & show `#pendingApproval` (wire the code-claim + solo buttons, and start `watchMyStatus`); active student or legacy doc → existing start-screen path unchanged.
- Add new handler functions near here: `showPending()`, `showApprovalDesk()`, `renderLinkedStudents()`, `onClaimCode()`, `onApprove(uid)`, `onDeny(uid)`, `playSolo()`.

### 7.4 Legacy backfill
- In `enterGame`, if a loaded profile has no `role`, treat as `student`/`active` in memory and write the backfill (`role:'student', status:'active'`) via the existing `saveProfile`/`setDoc merge` path so old players are grandfathered without a flag day.

### 7.5 Startup listener (`startAuthListener`, lines 3633–3652) and `showAuth` (1053–1061)
- `showAuth` additionally hides the two new overlays (via the existing `hideAllOverlays()` if the new overlays use the `.overlay` class — confirm they're swept; they will be since `hideAllOverlays` clears `.overlay.show`).
- `startAuthListener` unchanged in structure; `enterGame` now does the role branching, so the listener stays thin. Offline branch unchanged — pending/role logic is simply never reached offline.

### 7.6 Leaderboard
- `topScores` consumers (leaderboard render, ~search `lbBody`) filter out rows where `status === 'pending'`. Small client-side guard; documented as Phase 1 placeholder.

## 8. New Non-Client Files (committed, NOT deployed this phase)
- `firestore.rules` — the ruleset in §6.
- `firestore.indexes.json` — composite index on `links(adultUid, status)`.
- `firebase.json` — minimal config pointing `firestore.rules`/`firestore.indexes.json` (so a later `firebase deploy --only firestore:rules` is one command). No hosting block changed; GitHub Pages stays the host.

These are repo artifacts only; this step does **not** run `firebase deploy`/`login` and does not touch billing.

## 9. Testability
- **Security rules (unit-testable):** `@firebase/rules-unit-testing` against the Firestore emulator covers every attack case in §6.4. Add `test/firestore.rules.test.js` in a later implementation step; the emulator needs no live project and no gcloud. This is the highest-value test surface since rules are the real protection.
- **Client auth-flow logic:** the role-branching in `enterGame` and the pure helpers (`validUserid`, code generation, role validation) are unit-testable by extracting them as small pure functions; DOM-heavy paths are integration-tested manually against the emulator.
- **Manual integration:** signup as each role, student claims code, adult approves, student flips to active (live via `watchMyStatus`), offline fallback still works with Firebase blocked.
- Hard-to-test smell check: none of the above requires the live project; everything runs on the emulator, which keeps Phase 1 honest.

## 10. Out of Scope (Phase 1)
- AI agents / prompt-driven game builder / Vertex AI Gemini (later phase — the `links`/role model deliberately leaves Cloud Functions room and does not conflict).
- New question templates beyond the existing runner.
- Teacher-vs-parent capability differences, classes/groups, reporting dashboards.
- Server-side leaderboard filtering, code-claim rate limiting, adult identity verification.
- Deploying rules/hosting; anything touching live project `mathquest-ca395` or billing.

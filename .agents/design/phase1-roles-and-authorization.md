# Phase 1 Design — Three-Role Identity + Cross-Role Authorization

Status: REVISED (iteration 2, resolves design-review.json) • Branch: `feature/roles-and-authorization` • Scope: Phase 1 only (identity + authorization). AI agents / game builder are later phases.

> Revision note: this version resolves every HIGH/MEDIUM/NIT finding from `.agents/design/design-review.json`. See §11 "Responses to review findings" at the end for a point-by-point trace. The two HIGH fixes are: (1) security-rules now cross-check that an approving `adultUid` is a real adult account and forbid self-links (no self-approval chain); (2) the two new overlays are explicitly added to the `el` map and the `hideAllOverlays` array so they are actually hidden on transitions.

## 1. Overview

MathQuest today is a single-file static app (`index.html`, **3656 lines** — line numbers below are approximate, locate by function name / element id) served from GitHub Pages, with a `<script type="module">` block that wires Firebase v10.12.2 (Auth email/password + Firestore) and exposes `window.MathQuestCloud`. Firestore holds two collections: `users/{uid}` (per-player profile) and `usernames/{userid}` (unique userid → `{uid, email}` for userid-based login). If Firebase init fails, the game runs fully offline from a per-UID local cache.

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

- **(A) Adult-code claim.** Each adult has a short human-readable `linkCode` (e.g. `SUN42KQ`). The student (or the adult sitting with them) types the code to create a pending link; the adult then approves it from their approval list. Simple mental model, matches the existing "type a short thing" UX, and a code can be printed on a classroom board or texted to a parent.
- **(B) Adult-initiated invite by userid/email.** The adult enters the student's `userid` (or email) to create a pending link the student accepts. Reverses initiative to the adult.
- **(C) Pure pending-approval queue keyed on a shared class/family id.** Student joins a group by id; adult approves from the group queue. Heaviest — needs a groups collection and membership semantics we do not need yet.

**DECISION (recommended): (A) Adult-code claim — mechanism A only in Phase 1.** Mechanism B is explicitly deferred; no B client flow ships in Phase 1 (see §11, finding 10). Rationale:

- It fits the existing userid-first, "type a short code" interaction and the kid-friendly tone. A child can act without knowing their own email, and an adult can hand out one code to a whole class or one family.
- It keeps the student in control of initiating the link (they already just typed a userid/password), and keeps final authority with the adult (approval is still an explicit adult action). A code alone never activates a student — approval is a separate adult step, so a leaked code cannot auto-approve anyone.
- It needs only one new collection (`links`) plus a `linkCode` field on adult docs and a `linkCodes/{code}` lookup table — no groups/classes machinery, so it does not over-build for Phase 1 and does not conflict with adding classes later.
- Tradeoff vs. (B): a guessable/short code could let a stranger create a *pending* link to an adult (spam in the adult's queue). Mitigations: codes are random (not sequential), reasonably long (7 chars from an unambiguous alphabet), and a pending link grants **zero** capability until the adult approves — the worst case is queue noise the adult declines, never data exposure or activation. Rate-limiting code-claim attempts is deferred to Phase 2 (would want a Cloud Function; out of scope now). This is flagged below as a known limitation.

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

At student signup, the create payload is constrained by rules (§6) to `status: 'pending'`, `best: 0`, `approvedBy: null` — the client cannot self-create with a fabricated score or a pre-set approver.

Legacy docs created before Phase 1 have no `role`. Treated as `role: 'student', status: 'active'` (grandfathered — existing players keep playing and keep their leaderboard spot). The client backfills these fields lazily on next login (§7.4). Note: the create-payload constraint applies only to *new* `create` operations; legacy backfill goes through the self-`update` path (§6), which does not re-assert `best == 0` and so does not disturb an existing player's score.

### 4.2 `usernames/{userid}` (unchanged shape)

```
usernames/{userid} { uid: string, email: string }
```

Shape is **unchanged from today** — no `role` field is added in Phase 1 (mechanism B, the only consumer of that field, is deferred; see §11 finding 10). The doc still exists purely to resolve a userid → email for login and to enforce userid uniqueness.

### 4.3 `linkCodes/{code}` (new) — adult discovery index

```
linkCodes/{CODE} { adultUid: string, role: 'teacher'|'parent' }
```

Keyed by the uppercase code so a student can resolve a code to an adult uid with a single `getDoc` without being able to list/read adults' `users` docs. Code generation: 7 chars from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits ambiguous `I/O/0/1`). Created at adult signup; collision retried (re-generate if the doc already exists). This is a lookup table containing no PII (only a uid + role). The `role` written here is the adult's claimed role at signup; the **security rules independently verify it against the creator's own `users` doc** (§6), so a student cannot create a `linkCodes` entry claiming to be a teacher.

### 4.4 `links/{linkId}` (new) — the authorization records

One document per (student, adult) relationship. `linkId = "{studentUid}_{adultUid}"` (deterministic → idempotent claims, no duplicate pending links). Rules forbid `studentUid == adultUid` (no self-links; §6).

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

### 4.5 `leaderboard/{uid}` (new) — denormalized, world-readable global scores

```
leaderboard/{uid} { name: string, best: number, level: number, updated: timestamp }
```

This collection exists to fix the regression the review found (finding 5): the new restrictive `users` read rule (§6) denies reading other players' `users` docs, which would break the existing global-leaderboard query. Instead of loosening `users`, leaderboard data is **denormalized** into a world-readable collection carrying only the three non-PII fields the leaderboard table renders. Write rules (§6) ensure a user can only write their **own** `leaderboard/{uid}` row and only when they are an `active` non-pending account, so a pending student cannot inject a fabricated score. This keeps `users` fully private while preserving the global leaderboard.

- Who writes it: `saveProfile` (§7.1) writes `leaderboard/{uid}` **in addition to** `users/{uid}`, but only for accounts whose in-memory role/status is active (adults, or `active` students; never pending students, never legacy-before-backfill). Writing a denormalized row is cheap and idempotent (`setDoc merge`).
- Who reads it: the leaderboard query (§7.6) now reads `leaderboard`, not `users`.

### 4.6 Lookups / indexes

- Student resolves a code: `getDoc(linkCodes/{CODE})` — key lookup, no index.
- Adult lists their pending/approved students: `query(links, where('adultUid','==',me), where('status','in',['pending','approved']))` — composite index on (`adultUid`, `status`). Declared in `firestore.indexes.json` (committed, not deployed in this phase; so this exact `in`+equality index is untested against the live project/emulator in this phase — flagged in §11).
- Adult shows each linked student's name/status: `getDoc(users/{studentUid})` — allowed because a link exists (§6). Each such read, and each `users` read generally, incurs one `exists()`/`get()` on the link path inside `adultLinkedTo` — a per-read rule-eval/billing cost documented in §6.
- Student checks their own authorization: read their own `users/{uid}.status` (self-read; see live `watchMyStatus`, §7.1).
- Global leaderboard: `query(leaderboard, orderBy('best','desc'), limit)` — world-readable, no per-document deny (see §4.5).

## 5. Offline / Pending-Student Experience

- **Offline (Firebase unavailable):** unchanged. The game already falls back to local cache + local leaderboard. Role/status logic is skipped entirely; the user plays solo exactly as today. No regression. (Verified: `enterGame` role-branching is only on the online path; offline uses `getCached(uid)`.)
- **Pending student (online, not yet approved):** after login they land on a **"Waiting for approval"** screen (`#pendingApproval`) that explains a parent/teacher needs to approve them, shows a **"Have a code? Enter it"** field to claim an adult code, and offers a **"Play solo for now"** button. Playing solo uses the normal game loop but: (a) their score is **not** written to `leaderboard/{uid}` (the `saveProfile` write-guard skips pending accounts, and rules reject a pending write anyway), (b) they are flagged as pending in their profile.
- **pending → active live transition (specified; resolves finding 6).** A pending student's `#pendingApproval` screen starts a `watchMyStatus(cb)` `onSnapshot` on their own `users/{uid}`. When an adult approves and the snapshot fires `status === 'active'`:
  - If the student is **on the pending screen** (`state !== 'playing'`): transition immediately — hide `#pendingApproval`, run the normal active-student path (show `#start`), and **unsubscribe** the snapshot (one-shot; no further need).
  - If the student is **mid-game** (`state === 'playing'`): do **not** interrupt. Set an in-memory flag `justActivated = true` and leave the run alone. At the next natural screen boundary (game-over or level-clear handler), if `justActivated` is set, route to the start screen and clear the flag. This avoids a jarring yank out of a run.
  - The snapshot is **always unsubscribed** in `logout()` and once the student becomes active (both exits above), so there is no listener leak across sessions.
- **Active student / any adult:** adults go to the **Approval screen** (`#approvalDesk`: their linked students with approve/deny buttons, their own link code shown) and can still open the game. Active students go straight to the existing start screen.

## 6. Security Rules Strategy (`firestore.rules`) + Attack-Case Reasoning

Rules are the **only** real protection: the Firebase web config (`apiKey`, project id, etc.) is public in `index.html` (verified, `firebaseConfig` literal ~lines 544–552) and cannot be hidden in a static site. Anyone can instantiate the SDK against project `mathquest-ca395`. Therefore every invariant below is enforced server-side in rules, never by trusting the client. In particular, the client is untrusted even when it "follows the flow": the rules independently re-verify that an approving adult is really an adult, that a student is not acting as their own adult, and that a self-created `users` doc has a zero score and no approver.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function isSelf(uid) { return signedIn() && request.auth.uid == uid; }
    function incoming() { return request.resource.data; }
    function existing() { return resource.data; }

    // true iff the signed-in caller's OWN users doc exists and has the given role
    function callerRoleIs(roleList) {
      return signedIn()
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in roleList;
    }

    // ---- usernames: unique userid -> {uid,email}. Create once; readable so
    //      login can resolve userid->email. Never mutate someone else's.
    match /usernames/{userid} {
      allow read: if true;                         // needed pre-auth for login
      allow create: if isSelf(incoming().uid);     // you can only claim for yourself
      allow update, delete: if false;              // immutable in Phase 1
    }

    // ---- linkCodes: adult discovery table (uid + role only, no PII).
    //      The creator must actually BE the adult whose role they claim.
    match /linkCodes/{code} {
      allow read: if signedIn();                   // student resolves a code
      allow create: if isSelf(incoming().adultUid)
                    && incoming().role in ['teacher','parent']
                    && callerRoleIs([incoming().role]);   // real adult of that role
      allow update, delete: if false;
    }

    // ---- leaderboard/{uid}: denormalized world-readable scores (no PII beyond
    //      display name). Only an ACTIVE account may write its OWN row.
    match /leaderboard/{uid} {
      allow read: if true;                         // global leaderboard is public
      allow create, update: if isSelf(uid)
        && exists(/databases/$(database)/documents/users/$(uid))
        && (get(/databases/$(database)/documents/users/$(uid)).data.role != 'student'
            || get(/databases/$(database)/documents/users/$(uid)).data.status == 'active')
        && incoming().keys().hasOnly(['name','best','level','updated']);
      allow delete: if false;
    }

    // ---- users/{uid}
    match /users/{uid} {
      allow read: if isSelf(uid) || adultLinkedTo(uid);

      // Create own doc. role fixed at creation; students start pending with a
      // zero score and no approver (prevents a fabricated leaderboard entry).
      allow create: if isSelf(uid)
        && incoming().role in ['student','teacher','parent']
        && (incoming().role != 'student' ||
             (incoming().status == 'pending'
              && incoming().best == 0
              && incoming().approvedBy == null));

      // Self update: may change profile/progress, but NOT escalate.
      allow update: if isSelf(uid)
        && incoming().role == existing().role              // role immutable
        && incoming().status == existing().status          // can't self-approve
        && incoming().approvedBy == existing().approvedBy; // can't self-set approver

      // Adult approval: a REAL, LINKED adult (not the student themselves)
      // flips the student to active.
      allow update: if signedIn()
        && request.auth.uid != uid                         // no self-approval
        && callerRoleIs(['teacher','parent'])              // caller is a real adult
        && existing().role == 'student'
        && approvedLinkExists(uid, request.auth.uid)       // approved link to THIS adult
        && incoming().status == 'active'
        && incoming().role == existing().role
        && onlyStatusAndApprover(uid);

      allow delete: if false;
    }

    // ---- links/{studentUid_adultUid}
    match /links/{linkId} {
      allow read: if signedIn()
        && (isSelf(existing().studentUid) || isSelf(existing().adultUid));

      // Student creates a PENDING link to a REAL adult (mechanism A).
      // No self-links; the adultUid must be an existing teacher/parent.
      allow create: if isSelf(incoming().studentUid)
        && incoming().studentUid != incoming().adultUid
        && incoming().status == 'pending'
        && incoming().createdBy == request.auth.uid
        && linkId == incoming().studentUid + '_' + incoming().adultUid
        && exists(/databases/$(database)/documents/users/$(incoming().adultUid))
        && get(/databases/$(database)/documents/users/$(incoming().adultUid)).data.role in ['teacher','parent'];

      // Adult decides (approve/deny) on links addressed to them.
      allow update: if isSelf(existing().adultUid)
        && existing().status == 'pending'
        && incoming().status in ['approved','denied']
        && incoming().studentUid == existing().studentUid
        && incoming().adultUid == existing().adultUid;

      allow delete: if false;
    }

    function adultLinkedTo(studentUid) {
      return signedIn()
        && exists(/databases/$(database)/documents/links/$(studentUid + '_' + request.auth.uid));
    }
    function approvedLinkExists(studentUid, adultUid) {
      // exists()-guarded so a missing link is a clean deny, not an eval error.
      let path = /databases/$(database)/documents/links/$(studentUid + '_' + adultUid);
      return exists(path) && get(path).data.status == 'approved';
    }
    function onlyStatusAndApprover(uid) {
      // every field except status/approvedBy/updated must be unchanged
      return incoming().diff(existing()).affectedKeys().hasOnly(['status','approvedBy','updated']);
    }
  }
}
```

### 6.4 Attack-case reasoning pass

1. **Student self-approves via self-update.** Self-`update` branch requires `incoming().status == existing().status`, so a student can never change their own `status` directly. Blocked. ✔
2. **Student self-approves via a self-link chain (the HIGH finding).** Attempted chain: create `linkCodes/{C}` claiming `role:'teacher'` for own uid → create `links/{own_own}` → approve it as own "adult" → flip own `users.status` to active. Now blocked at **every** step:
   - `linkCodes` create requires `callerRoleIs([incoming().role])` — a student's own `users.role` is `'student'`, so claiming `'teacher'` fails. ✘ at step 1.
   - `links` create requires `incoming().studentUid != incoming().adultUid` **and** the target's `users.role in ['teacher','parent']`. A self-link fails the inequality; pointing at a real adult is fine but the student is no longer the adult. ✘ at step 2 for self; the only valid link is student→real-adult.
   - `users` adult-approval branch requires `request.auth.uid != uid` and `callerRoleIs(['teacher','parent'])`. A student calling it on their own doc fails both. ✘ at step 4.
   The self-approval path is closed at three independent gates. Blocked. ✔
3. **Student reads another user's doc.** `users` read allows `isSelf(uid)` or `adultLinkedTo(uid)`. A student is never "linked as the adult" of another user, so cross-student reads fail. Blocked. ✔ (Cross-player scores are still visible, but only via the denormalized world-readable `leaderboard` collection, which holds no PII beyond the display name the player chose to show.)
4. **Fabricated leaderboard score at `users` create (MEDIUM finding).** Student `create` now forces `best == 0 && approvedBy == null && status == 'pending'`. A self-created doc cannot carry a fake score. And the leaderboard no longer reads `users` at all (§4.5). `leaderboard/{uid}` write is allowed only for an `active` account writing its own row, so a pending student cannot inject a score there either. Blocked. ✔
5. **Role escalation at signup.** `create` pins `role in {...}` and forces students to start `pending`. A user could *choose* `teacher` at signup — this is accepted by design in Phase 1 (self-declared adult), called out as a known limitation. They still cannot touch anyone else's data; being a teacher only grants power over students who *claim your code and whom you approve*. ✔ (with noted limitation)
6. **Role escalation on update.** Both self-update and adult-update branches require `incoming().role == existing().role`. `role` is immutable post-creation. Blocked. ✔
7. **Adult activates a student they were never approved for.** Approval branch calls `approvedLinkExists(uid, auth.uid)`, which is now `exists()`-guarded and checks `status == 'approved'`. No approved link → clean deny, no eval error (resolves finding 4). And an adult can only move a link to `approved` on a link whose `adultUid` is themselves. Blocked. ✔
8. **Adult over-writes a student's profile under cover of approval.** `onlyStatusAndApprover` restricts the adult's diff to `status`/`approvedBy`/`updated`. An adult cannot change a student's score, grade, name, etc. ✔
9. **Spoofing a link to gain read access to a stranger.** `adultLinkedTo` only returns true if a `links/{student_adult}` doc exists, and a student creating that doc can only set `status: 'pending'` with `createdBy == self`, pointing at a *real adult*. A pending link grants the adult read of the student's own doc (needed to show the name in the approval queue) but **no write power** until the adult approves. Residual: a student can expose their own doc to any real-adult uid by linking; acceptable (it's the student's own data and the intended flow). ✔
10. **Queue spam via guessed codes.** A stranger who guesses an adult's code can create a *pending* link (queue noise). It grants zero capability and the adult declines it. Rate-limiting deferred (needs a Function). Documented limitation. ⚠

> Rule-eval cost note (finding 4): the `users` read rule calls `adultLinkedTo`, which runs one `exists()` per read; the adult-approval and link-create rules run additional `get()`/`exists()` lookups. These are per-operation document reads billed against the project. Acceptable at Phase 1 scale; the leaderboard (the only high-fanout read path) was deliberately moved off `users` to `leaderboard`, which has a trivial `allow read: if true` and no cross-doc lookups.

### Known limitations (explicit, for reviewer)

- **Self-declared adult role at signup.** Phase 1 has no verification that a "teacher"/"parent" is really an adult. Standard for an MVP and bounded (an adult only gains power over students who opt in by claiming their code). Real verification (email domain, invite tokens, admin) is a later phase.
- **No code-claim rate limiting** (queue spam). Needs a Cloud Function — deferred to keep Phase 1 build-free.
- **Leaderboard denormalization is eventually-consistent.** A player's `leaderboard` row is written alongside their `users` write in `saveProfile`; a partial failure could leave the two briefly out of sync. Acceptable for a cosmetic leaderboard; no correctness or auth impact.
- **Composite index untested this phase.** `firestore.indexes.json` is committed but not deployed, so the `links(adultUid, status)` index behind the `in`+equality query is not verified against the live project/emulator in this step.

## 7. Client Changes in `index.html` (exact regions)

All edits stay inline / in the existing module; no new files loaded in the browser except Firebase (already loaded). Line numbers are approximate current-state anchors (file is **3656 lines**) — **locate by function name / element id, not line number.**

### 7.1 Firebase module block (`<script type="module">`, ~lines 516–688)
- Add collection constants `LINKS = "links"`, `LINKCODES = "linkCodes"`, `LEADERBOARD = "leaderboard"` beside the existing `USERS`/`USERNAMES` (~line 565).
- Import additions from the already-used firestore module URL (`https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js`, ~line 524): add `updateDoc`, `where`, `onSnapshot`. (**Do not** import `deleteField` — no Phase 1 flow deletes a field; resolves finding 9.)
- Extend `signup(...)` (~lines 585–620) to accept `role`. Validate `role in {student,teacher,parent}`. On student signup write `status:'pending', approvedBy:null, best:0`. On adult signup generate a unique `linkCode`, write `linkCodes/{code}` (`{adultUid, role}`), and store `linkCode` + `role` on the `users` doc. **Do not** write `role` into the `usernames/{id}` mapping — its shape is unchanged (resolves finding 10).
- **Keep `onAuthChange` thin.** The listener callback (~line 576) stays `{uid, name}` exactly as today. Role/status branching happens in `enterGame`, which already calls `loadProfile(uid)` and has the full doc — no second read, no extended payload (resolves finding 8).
- Add new `MathQuestCloud` methods:
  - `claimCode({code})` — student resolves `linkCodes/{CODE}`, then `setDoc(links/{self}_{adultUid})` with `status:'pending'`.
  - `listLinkedStudents()` — adult `query(links, where('adultUid','==',me), where('status','in',['pending','approved']))`, then `getDoc(users/{studentUid})` per row for name/status.
  - `approveStudent({studentUid})` / `denyStudent({studentUid})` — adult `updateDoc(links/...)`; on approve also `updateDoc(users/{studentUid}, {status:'active', approvedBy:me, updated:serverTimestamp()})`.
  - `watchMyStatus(cb)` — `onSnapshot` on own `users/{uid}`; returns the unsubscribe function so callers can detach it (see §5 lifecycle).
  - `myLinkCode()` — getter returning the adult's own `linkCode`.
- Extend `saveProfile` (~line 655): after writing `users/{uid}`, if the in-memory profile is an active account (adult, or `active` student — never pending, never pre-backfill legacy), also `setDoc(leaderboard/{uid}, {name, best, level, updated}, {merge:true})`. This is the only writer of the denormalized leaderboard row.

### 7.2 Auth UI HTML (`#auth` overlay, ~lines 342–367)
- Add a **role picker** to the Sign Up pane (`#signupPane`): three selectable buttons (I'm a Student / Parent / Teacher) styled with the existing `.grade-btn`/`.color-swatch` pattern and pastel palette. Default = Student.
- Add two new overlays after `#auth` (sibling `<div class="overlay">` blocks): `#pendingApproval` (waiting screen: explanation, "Enter adult code" input + button, "Play solo for now" button) and `#approvalDesk` (adult screen: your link code displayed, list of pending/approved students with Approve/Deny buttons, "Open game" button).
- Reuse existing CSS classes (`.overlay`, `.btn`, `.btn.big`, `.auth-hint`, `.grade-btn`). Add a small `.role-btn`/`.student-row` CSS block in the `/* Auth */` CSS region (~lines 151–171) matching the rounded-card pastel style (`"Comic Sans MS"`/`"Trebuchet MS"`, rounded cards, existing shadow).

### 7.3 Auth flow JS (functions ~lines 1053–1175)
- `doSignup` (~1073): read the selected role, pass it to `cloud().signup`.
- `enterGame` (~1104): after `loadProfile`, branch on `role`/`status` **from the already-loaded profile** (no extra read): adult → render & show `#approvalDesk`; pending student → render & show `#pendingApproval` (wire the code-claim + solo buttons, start `watchMyStatus` and keep the returned unsubscribe); active student or legacy doc → existing start-screen path unchanged (`hideAllOverlays()` + `el.start.classList.add("show")`).
- Add new handler functions near here: `showPending()`, `showApprovalDesk()`, `renderLinkedStudents()`, `onClaimCode()`, `onApprove(uid)`, `onDeny(uid)`, `playSolo()`. Store the `watchMyStatus` unsubscribe in a module-scope `let unsubMyStatus = null`; implement the §5 transition rule (immediate if on pending screen, deferred via `justActivated` flag if `state === 'playing'`) and call `unsubMyStatus?.()` on transition-to-active.

### 7.4 Legacy backfill
- In `enterGame`, if a loaded profile has no `role`, treat as `student`/`active` in memory and write the backfill (`role:'student', status:'active', approvedBy:null`) via the existing `saveProfile`/`setDoc merge` path (self-`update` rule branch — not the constrained `create` branch, so an existing player's score is untouched). Old players are grandfathered without a flag day.

### 7.5 Startup listener (`startAuthListener`, ~line 3634) and `showAuth`/overlay plumbing
- **Register the two new overlays so they are actually hidden (resolves the HIGH finding 2).** Add to the `el` map (~line 701 region): `pendingApproval: document.getElementById("pendingApproval")` and `approvalDesk: document.getElementById("approvalDesk")`. Then add `el.pendingApproval, el.approvalDesk` to the hardcoded array inside `hideAllOverlays()` (~line 2392):
  ```js
  [el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown,
   el.help, el.scratch, el.leaderboard, el.pendingApproval, el.approvalDesk]
    .forEach(o => o.classList.remove("show"));
  ```
  This is required — `hideAllOverlays` sweeps a hardcoded element list, **not** `.overlay.show`; without this edit the new overlays would stay stuck on top of the game. (We keep the hardcoded-array approach rather than refactoring to `querySelectorAll('.overlay.show')`, to avoid an unrelated behavior change to existing transitions.)
- `showAuth` (~line 1053) calls `hideAllOverlays()` already, so once the two overlays are in that array they are correctly cleared on the auth transition. No other change to `showAuth`.
- `startAuthListener` unchanged in structure; `enterGame` does the role branching, so the listener stays thin. Offline branch unchanged — pending/role logic is never reached offline. Add `unsubMyStatus?.()` to `logout()` so the status snapshot is detached on sign-out (no listener leak; §5).

### 7.6 Leaderboard
- Add a `MathQuestCloud` method (or repoint `topScores`) to read the denormalized collection: `query(collection(db, LEADERBOARD), orderBy('best','desc'), limit(max))` instead of querying `users` (resolves the regression in finding 5 — the restrictive `users` read rule no longer blocks the leaderboard). `renderLeaderboardRows` (~line 2030) is unchanged; it already reads `name/best/level`, which the `leaderboard` docs carry. Pending students never appear because they never get a `leaderboard` row written.

## 8. New Non-Client Files (committed, NOT deployed this phase)
- `firestore.rules` — the ruleset in §6.
- `firestore.indexes.json` — composite index on `links(adultUid, status)`.
- `firebase.json` — minimal config pointing `firestore.rules`/`firestore.indexes.json` (so a later `firebase deploy --only firestore:rules` is one command). No hosting block changed; GitHub Pages stays the host.

These are repo artifacts only; this step does **not** run `firebase deploy`/`login` and does not touch billing.

## 9. Testability
- **Security rules (unit-testable, highest value):** `@firebase/rules-unit-testing` against the Firestore emulator covers every attack case in §6.4 — including the self-link chain (finding 1): assert that a student cannot create `linkCodes` claiming teacher, cannot create a self `links` doc, and cannot call the adult-approval branch on their own `users` doc. Add `test/firestore.rules.test.js` in a later implementation step; the emulator needs no live project and no gcloud.
- **Client auth-flow logic:** the role-branching in `enterGame`, the `justActivated` deferral rule, and the pure helpers (`validUserid`, code generation, role validation) are unit-testable by extracting them as small pure functions; DOM-heavy paths are integration-tested manually against the emulator.
- **Manual integration:** signup as each role; student claims code; adult approves; student flips to active live via `watchMyStatus` (test both on-pending-screen immediate transition and mid-game deferral); leaderboard reads from `leaderboard` and excludes pending; logout detaches the snapshot; offline fallback still works with Firebase blocked.
- Hard-to-test smell check: none of the above requires the live project; everything runs on the emulator.

## 10. Out of Scope (Phase 1)
- AI agents / prompt-driven game builder / Vertex AI Gemini (later phase — the `links`/role model deliberately leaves Cloud Functions room and does not conflict).
- New question templates beyond the existing runner.
- Teacher-vs-parent capability differences, classes/groups, reporting dashboards.
- Mechanism B (adult-initiated invite) — deferred; no `usernames.role` field in Phase 1.
- Server-side leaderboard *filtering logic beyond the active-only write guard*, code-claim rate limiting, adult identity verification.
- Deploying rules/hosting; anything touching live project `mathquest-ca395` or billing.

## 11. Responses to review findings (`design-review.json`)

- **Finding 1 — HIGH, self-linking privilege escalation. ADDRESSED.** Added a `callerRoleIs()` helper that reads the caller's *own* `users` doc. `linkCodes` create now requires `callerRoleIs([incoming().role])`; `links` create forbids `studentUid == adultUid` and requires the target to be a real adult; the `users` adult-approval branch requires `request.auth.uid != uid` and `callerRoleIs(['teacher','parent'])`. The self-approval chain is closed at three gates (§6.4 case 2).
- **Finding 2 — HIGH, `hideAllOverlays` false claim. ADDRESSED.** §7.5 now explicitly requires adding `pendingApproval`/`approvalDesk` to the `el` map and to the hardcoded `hideAllOverlays` array (with the exact array shown). The false "sweeps `.overlay.show`" justification is removed; the hardcoded-array nature of the function is stated correctly.
- **Finding 3 — MEDIUM, unconstrained `best`/approver at create. ADDRESSED.** Student `create` rule now requires `status == 'pending' && best == 0 && approvedBy == null` (§6, §4.1). §4.1 notes the constraint applies to `create` only, so legacy backfill via self-`update` is unaffected.
- **Finding 4 — MEDIUM, `approvedLinkExists` unguarded `get()`. ADDRESSED.** Helper rewritten to `exists(path) && get(path).data.status == 'approved'` (§6). Per-read `get()`/`exists()` cost documented (§4.6, §6.4 cost note).
- **Finding 5 — MEDIUM, leaderboard query denied. ADDRESSED (option a).** Introduced a denormalized world-readable `leaderboard/{uid}` collection (§4.5) with rules allowing public read and active-only self-write; `topScores`/leaderboard query repointed to it (§7.6). `users` stays private, no regression.
- **Finding 6 — MEDIUM, pending→active transition underspecified. ADDRESSED.** §5 now specifies: immediate transition if on the pending screen; defer via a `justActivated` flag to the next game-over/level-clear if mid-game; unsubscribe the snapshot on logout and once active. `watchMyStatus` returns its unsubscribe function (§7.1), stored in `unsubMyStatus` (§7.3) and called in `logout()` (§7.5).
- **Finding 7 — NIT, stale line anchors. ADDRESSED.** File length corrected to 3656; a "locate by function name / element id" note added at §1 and §7; anchors updated (firebase block ~516–688, `startAuthListener` ~3634, `hideAllOverlays` ~2392).
- **Finding 8 — NIT, `onAuthChange` either/or. ADDRESSED.** Resolved to a single choice: listener stays `{uid, name}`; `enterGame` branches on role/status from the profile it already loads (§7.1).
- **Finding 9 — NIT, unused `deleteField`. ADDRESSED.** Dropped from the import list (§7.1).
- **Finding 10 — NIT, unused `usernames.role`. ADDRESSED.** `usernames` shape left unchanged; no `role` field added; mechanism B explicitly deferred (§4.2, §3, §10).

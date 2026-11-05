# Phase 1 Design — Three-Role Identity + Cross-Role Authorization

Status: REVISED (iteration 6 — email-invite case-normalization fix) • Branch: `feature/roles-and-authorization` • Scope: Phase 1 only (identity + authorization). AI agents / game builder are later phases.

> Revision note (iteration 6 — EMAIL-INVITE CASE-NORMALIZATION FIX): the iteration-5 review (verdict CHANGES_REQUESTED, 1 MEDIUM + 2 NITs) found the new PRIMARY email-invite path was unreachable for any non-all-lowercase email, because the invite id/`targetValue` are stored lowercased while `callerEmail()` returned the student's **verbatim-case** stored email (verified in source: signup writes `email` raw at `index.html` ~608/~612 — trimmed, not lowercased). This iteration pins a **single email-normalization point** and applies it identically across all four touch points: (a) the stored `targetValue` (already `.lower()` in rule branch (a)), (b) the document id, (c) the rule helpers `callerEmail()`/`emailInviteToMe`, and (d) the client `listMyInvites` query. The chosen fix is the rule-side normalization (no data migration, local to the changed flow): `callerEmail()` now returns `get(...).data.email.lower()`, and the client normalizes the student's own email with `lower(trim(...))` before the `targetValue` discovery query and before reconstructing the canonical accept doc. Two NITs are also resolved: the `acceptInvite` email branch no longer persists a `'?'` placeholder for `adultRole` (it carries the real role read from the invite, or `null`, and the field type widens to `'teacher'|'parent'|null`); and the `saveProfile` anchor is tightened to ~659. No security guarantee changed — the prior mismatch failed *closed* (no privilege hole), so this is purely a feasibility repair of the primary email path plus schema/anchor polish. See §15 for the point-by-point trace of this iteration.
>
> Revision note (iteration 5 — LINKING MECHANISM CHANGE): per the user's latest instruction ("modify to adult invites by userid/email … nice to have code as well in case email doesn't work as fall back"), the linking/authorization model is changed from the old "student claims the adult's code" single flow to a **bidirectional** model. PRIMARY is now **adult-initiated invite by userid or email**: a teacher/parent addresses an invite to a student, the student sees it on login and **accepts**, which activates them. FALLBACK keeps the adult's **shareable code** demoted to a backup student-initiated path: if the invite doesn't reach the student, the student types the adult's code to request a link and the adult approves it. BOTH directions end with the student `active` and linked to that adult. Only the linking sections changed: §3 (decision), §4.2/§4.3/§4.4 (collections — `usernames` now also stores `email`; `linkCodes` retained for the fallback; `links` reshaped and merged with the invite record), §6 (security rules + new attack cases for the invite flow), §5 and §7.2/§7.3 (UI: adult invite-a-student input + invite-status list; student pending-invite list with Accept + enter-a-code fallback; adult approve-code-request surface). Everything else is retained as approved: the security-rules architecture, roles, extended `users/{uid}`, denormalized world-readable `leaderboard/{uid}`, role immutability, offline fallback, UI style, and the live `pending→active` transition via `watchMyStatus`. The 4 residual findings from the last review (1 MEDIUM `watchMyStatus(uid,cb)`, 3 NITs) are carried forward and specified in §13/§14. See §14 for this iteration's point-by-point trace.
>
> Revision note (iteration 4): the latest review (verdict CHANGES_REQUESTED, 1 MEDIUM, 0 HIGH, 2 NITs) accepted the security-rules strategy and the client data-flow mechanisms. The remaining findings were anchor/naming precision on the client edits: (1) MEDIUM — the deferred-transition hook function was wrongly named `levelClear()`; the real handler is `levelCleared()` (line 1971), while `levelClear` is only an element id / state string. Corrected everywhere, with anchors fixed to `gameOver()` ~2005 and `levelCleared()` ~1971. (2) NIT — named the live leaderboard-write trigger `submitBestToCloud()` → `persistProgress({immediate:true})` → `saveProfile` and flagged the now-stale `~line 1210` comment for a one-line update. (3) NIT — pinned the pending screen to an explicit `state = "pending"`. See §13 for the point-by-point trace of this iteration; §12 retains the trace of the prior iteration.
>
> Revision note (iteration 3): the security-rules strategy was accepted by the latest review (verdict CHANGES_REQUESTED on 2 MEDIUM client-data-flow details, 0 HIGH). This iteration resolves both MEDIUMs and both NITs by pinning down the two cross-script data-flow mechanisms the review flagged: (1) a `leaderboardEligible` flag on the cloud object, set from named call sites, is how `saveProfile` decides whether to write the leaderboard row (it cannot see `role`/`status`); (2) `watchMyStatus` is a thin module wrapper whose callback is a main-script `onMyStatus(data)` owning `state`/`justActivated`, with the deferred transition added to the named `gameOver()`/`levelCleared()` handlers. See §12 for the point-by-point trace of this iteration; §11 retains the trace of the prior iteration.

## 1. Overview

MathQuest today is a single-file static app (`index.html`, **3656 lines** — line numbers below are approximate, locate by function name / element id) served from GitHub Pages, with a `<script type="module">` block that wires Firebase v10.12.2 (Auth email/password + Firestore) and exposes `window.MathQuestCloud`. Firestore holds two collections: `users/{uid}` (per-player profile) and `usernames/{userid}` (unique userid → `{uid, email}` for userid-based login). If Firebase init fails, the game runs fully offline from a per-UID local cache.

Phase 1 layers a three-role identity model (`student`, `teacher`, `parent`) and a cross-role authorization flow onto this setup **without a build step, without a framework, and without breaking the offline fallback**. A newly signed-up student is PENDING and cannot appear on global leaderboards or be assigned work until a linked parent or teacher approves them. Students can still play solo immediately so the app is never a dead end for a kid waiting on an adult.

The technology stack is **locked** for this phase: plain HTML/CSS/vanilla-JS, Firebase Web SDK v10.12.2 loaded from the gstatic CDN as ES modules (same versions already imported), Firebase Auth (email/password), Cloud Firestore, and a new `firestore.rules` file. No bundler, no npm runtime dependency, no framework. No Cloud Functions in Phase 1 (but the model must not block adding Functions + Vertex AI Gemini later).

## 2. Role Model

Every account has exactly one `role`, chosen once at signup and stored on `users/{uid}`:

- **student** — plays the runner; later creates games/puzzles. On signup `status = 'pending'`. A pending student can play solo (offline-style) but is excluded from global leaderboards and cannot be assigned work. After a linked adult approves, `status = 'active'`.
- **teacher** — an adult. Can **invite** a student by userid/email (primary) and can see/approve students who requested a link via the adult's shareable code (fallback). Sees each outstanding invite's state (sent/accepted) and each pending code-request. Teachers and parents are functionally identical in Phase 1 authorization power; the distinction is for later features (classes vs. family) and reporting.
- **parent** — an adult, same authorization capability as teacher.

Roles are **not** a privilege ladder a user can climb. `role` is write-once at document creation and immutable thereafter (enforced in security rules, §6). There is no "admin" role in Phase 1.

Adults (`teacher`/`parent`) are `active` the moment they sign up — they are not gated. Only students carry a `status` lifecycle. Adult docs may omit `status` or set it to `'active'`; rules treat a missing `status` on a non-student as fine.

## 3. Authorization / Linking Mechanism — DECISION (human can veto)

Per the user's instruction, linking is now **bidirectional**. A single `links/{studentUid_adultUid}` document models the (student, adult) relationship regardless of who started it; a `source` field records which direction created it and the `status` lifecycle drives activation. Both directions converge on the same end state: `links.status == 'approved'` **and** the student's `users.status == 'active'`, linked to that adult.

**PRIMARY — adult invites by userid or email (adult-initiated).**
1. A teacher/parent enters a student's **userid** or **email** and sends an invite. This creates a `links` doc with `status: 'invited'`, `source: 'invite'`, `adultUid: self`, `studentUid: <resolved target>`.
2. The target student, on login, sees pending invite(s) each labelled with the inviting adult's name, and **Accepts** one. The student's accept write moves the link to `status: 'accepted'` and, in the same flow, flips the student's own `users.status` to `active`. One accepted invite activates the student.
3. The adult sees the invite's state (**sent** → **accepted**) on their approval desk.

**FALLBACK — adult's shareable code (student-initiated, demoted from the old primary).**
1. Each teacher/parent still has a short human-readable `linkCode` (e.g. `SUN42KQ`), created at signup, stored in a `linkCodes/{CODE}` lookup table. If the invite doesn't reach the student (wrong email, typo, no account yet when invited, etc.), the student types the adult's code on their pending screen.
2. This creates a `links` doc with `status: 'requested'`, `source: 'code'`, `createdBy: student`. The adult then **approves** it from their approval desk, and the adult's approve write flips the student to `active`.

So both initiatives exist and both terminate in the same linked+active state; they differ only in who creates the `links` doc and who performs the activating write (student's accept for invites, adult's approve for code-requests). A single activation from any one adult is sufficient (do not require both a parent and a teacher); additional adults may still link afterward.

### 3.1 DECISION — how an invite by **email** resolves to a `uid` (human can veto)

The app already has `usernames/{userid} -> {uid, email}` and logs in by userid. An invite by userid resolves the target `uid` by reading `usernames/{userid}` directly. An invite by **email** has no index today. Two options were considered:

- **(E1) Store `email` on the `usernames` record (already present) and address the invite by the student's `uid`, resolved at send time by the adult.** The adult would need to find the uid from the email — but `usernames` is keyed by *userid*, not email, so email→uid is not a single key read; it needs either an email→uid index or a query over `usernames` by `email` (a new composite/field index, and `usernames` is world-readable pre-auth which makes an email-enumeration query undesirable).
- **(E2) Address the invite by the **raw identifier** the adult typed and let the **student** match it at login.** The adult writes the invite with `targetKind: 'userid'|'email'` and `targetValue: <normalized identifier>` and a derived `studentUid` **only when the identifier is a userid** (resolvable via `usernames/{userid}`). For an **email** invite the adult cannot resolve a uid (no email index, and email enumeration is a privacy risk), so the invite is stored addressed to the raw email with `studentUid: null`; the **student matches it on their own side at login** by querying invites whose `targetValue` equals *their own* email (which the student knows — it is on their own account) and, on accept, stamps their own `studentUid` into the link as part of the activating write.

**DECISION (recommended): (E2) — address by raw identifier; student self-matches email invites; userid invites are pre-resolved to a uid by the adult.** Rationale, and why it is the simplest robust option that fits the existing userid login and the public-config security model:

- It needs **no email→uid index** and performs **no email enumeration**: the adult never reads another user's email; for an email invite the adult only writes the (already-known-to-them) email string they typed. The only party that reads an email-addressed invite is the student it is addressed to, who already knows their own email. This keeps `usernames` (world-readable) from becoming an email-lookup oracle.
- Userid invites *are* pre-resolved (the adult reads `usernames/{userid}` — a single key read of a world-readable doc that already exists for login — to get the target `uid`), so the common "I know their username" case stores a fully-addressed `studentUid` and the student's accept is a simple exact-doc match. Only the email case defers resolution to the student.
- It reuses one `links` collection for both directions and both address kinds; no new groups/classes machinery; does not conflict with adding classes or Cloud Functions later.
- Security consequence (enforced in §6): because an email invite carries `studentUid: null` until accepted, the **accept rule must require the accepting student's own account email to equal the invite's `targetValue`** (server-side, read from the student's own `users`/auth record), so a student cannot accept an email invite addressed to someone else. Userid invites already carry the resolved `studentUid`, so their accept requires `request.auth.uid == studentUid`.

To make `usernames` usable for userid resolution and to let the email-match rule compare against a stored value, the `usernames/{userid}` record **already contains `email`** (verified: `setDoc(unameRef, { uid, email })`), so no shape change is needed there (resolves the old "no email index" concern without adding one). See §4.2.

### 3.1.1 Email normalization — SINGLE canonical point (resolves iteration-5 finding 1)

Email is case-insensitive in practice, but the app stores the signup email **verbatim** (trimmed, not lowercased): verified at `index.html` ~1075 (`el.signupEmail.value.trim()`), ~608 (`setDoc(unameRef, { uid, email })`), ~612 (`setDoc(users/{uid}, { …, email, … })`). So a student who signs up as `Alice@Example.com` has `users.email == "Alice@Example.com"`. If the email-invite id and `targetValue` are lowercased (they are — see §4.4 and rule branch (a)) but the accept-side match compares against the raw stored email, the match fails for every mixed-case email and the PRIMARY email path becomes unreachable (it fails *closed* — no privilege hole, but a broken feature).

**The canonical normalization is `lower(trim(x))`, applied at exactly one logical point on each side, and all four touch points MUST agree:**

| Touch point | Where | How it normalizes |
| --- | --- | --- |
| (a) stored `targetValue` on the invite | adult `inviteStudent` (client, §7.1) + rule branch (a) assertion | client writes `key = lower(trim(email))`; rule asserts `incoming().targetValue == incoming().targetValue.lower()` |
| (b) invite document id | adult `inviteStudent` (client) + rule branch (a) assertion | id = `'email|' + adultUid + '|' + key`; rule asserts `linkId == 'email|' + request.auth.uid + '|' + incoming().targetValue` (and `targetValue` is already lowercased by (a)) |
| (c) accept-side match | rule helpers `callerEmail()` / `emailInviteToMe` (§6) | `callerEmail()` returns `get(users/{auth.uid}).data.email.lower()` — **lowercased in the rule**, so the reconstructed id and the `targetValue == callerEmail()` check both use the lowercased form |
| (d) student discovery query | client `listMyInvites({ myEmail })` (§7.1) | the caller passes `myEmail = lower(trim(storedEmail))`, so `where('targetValue','==',myEmail)` matches the lowercased stored `targetValue` |

The design does **not** lowercase the email at signup (that would touch a settled write and need a one-time backfill of existing docs). Instead the rule normalizes on read via `.lower()` — the Firestore rules language exposes `.lower()` on the string returned by `get(...).data.email` (the design already relies on `.lower()` for `targetValue` in branch (a), so this is a consistent use of the same operator). `trim` is unnecessary on the stored `users.email` because signup already trimmed it (~1075); the client still applies `lower(trim(...))` defensively before the discovery query. This is a pure feasibility fix: no security property changes, and the mismatch it repairs previously failed closed.

> **VETO POINTS for the human reviewer:** (1) E2 (raw-identifier + student self-match on email) vs. E1 (email→uid index on send); (2) "one accept/approve activates" vs. "require a specific adult type"; (3) whether invite/code-request spam needs rate limiting in Phase 1 (currently deferred — a stranger can at worst create queue noise that the adult declines, never activation or data exposure); (4) keeping the shareable code as the fallback vs. dropping it.

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

### 4.2 `usernames/{userid}` (unchanged shape — now also a userid→uid resolver for invites)

```
usernames/{userid} { uid: string, email: string }
```

Shape is **unchanged from today** — no `role` field is added in Phase 1. The doc already carries both `uid` and `email` (verified: `setDoc(unameRef, { uid, email })` at signup). In the new bidirectional model it serves three read purposes, all single-key reads of this world-readable collection: (1) resolve userid → email for login (existing); (2) enforce userid uniqueness at signup (existing); (3) **resolve a userid → uid when an adult sends a *userid* invite** (new — the adult reads `usernames/{userid}` to pre-fill the invite's `studentUid`). No field is added. Email invites do **not** read this collection by email (that would need an email index / enable enumeration) — see the E2 decision in §3.1; email resolution is deferred to the student's own accept.

### 4.3 `linkCodes/{code}` (new) — adult discovery index (FALLBACK path only)

```
linkCodes/{CODE} { adultUid: string, role: 'teacher'|'parent' }
```

Retained from the approved design, now used **only by the fallback** (student types the adult's code when the invite doesn't reach them). Keyed by the uppercase code so a student can resolve a code to an adult uid with a single `getDoc` without being able to list/read adults' `users` docs. Code generation: 7 chars from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits ambiguous `I/O/0/1`). Created at adult signup; collision retried (re-generate if the doc already exists). This is a lookup table containing no PII (only a uid + role). The `role` written here is the adult's claimed role at signup; the **security rules independently verify it against the creator's own `users` doc** (§6), so a student cannot create a `linkCodes` entry claiming to be a teacher.

### 4.4 `links/{linkId}` (new) — the authorization records (both directions)

One document per (student, adult) relationship, regardless of who initiated it. It merges the old "link" and the new "invite" into one record so a student and an adult never create competing docs for the same pair. The `source` field records the direction; `status` drives the lifecycle.

**Document id.**
- **userid invite / code-request:** `linkId = "{studentUid}_{adultUid}"` (deterministic → idempotent; a re-send/re-request for the same pair overwrites-or-no-ops rather than duplicating).
- **email invite (studentUid not yet known):** the adult cannot build the deterministic student-keyed id (no `studentUid`), so an email invite uses an **adult+email id** `linkId = "email|{adultUid}|{normalizedEmail}"` where `normalizedEmail` is `lower(trim(email))`. Firestore document ids may contain `@` and `.` (only `/` and a few reserved names are disallowed), so the email is used verbatim after lowercasing — **no lossy slug**, which matters because the rules must *reconstruct this exact id* from the accepting student's own email (`callerEmail()`) to verify the invite. The `|` separator avoids collision with the userid-invite `studentUid_adultUid` scheme (uids/userids never contain `|`). This id is adult-owned (prefix carries `adultUid`) and unique per (adult, email). On accept the student does **not** mutate this doc's key; instead the student *creates* the canonical `links/{studentUid}_{adultUid}` doc in `accepted` (rules branch (c2)), and this `email|...` invite is left in place (the adult still sees it as "sent", and either party may later decline it).

Rules forbid `studentUid == adultUid` (no self-links; §6).

```
links/{linkId} {
  studentUid:  string | null,       // null only for an un-accepted email invite
  adultUid:    string,
  adultRole:   'teacher' | 'parent' | null,  // null allowed only on the canonical doc a student creates when accepting an EMAIL invite and the role is unknown (see §7.1); never '?'
  source:      'invite' | 'code',   // 'invite' = adult-initiated; 'code' = student-initiated fallback
  targetKind:  'userid' | 'email' | null,  // how an invite addressed the student (null for code-requests)
  targetValue: string | null,       // userid (normalized via normalizeUserid) or email (normalized via lower(trim(...)), §3.1.1) the invite was addressed to (null for code-requests)
  status:      'invited' | 'accepted' | 'requested' | 'approved' | 'denied',
  createdBy:   string,               // uid that created the doc (adult for invites, student for code-requests)
  createdAt:   timestamp,
  decidedAt:   timestamp | null,     // set when accepted/approved/denied
}
```

**Status lifecycle by direction:**
- Adult-initiated invite: `invited` --(student accepts)--> `accepted` (activates student) | --(adult/ student declines)--> `denied`.
- Student-initiated code-request (fallback): `requested` --(adult approves)--> `approved` (activates student) | --(adult denies)--> `denied`.

Both `accepted` and `approved` are terminal "linked & active" states; the design treats either as an active link (the leaderboard/read helpers accept both). `invited` and `requested` are the two pending states.

### 4.5 `leaderboard/{uid}` (new) — denormalized, world-readable global scores

```
leaderboard/{uid} { name: string, best: number, level: number, updated: timestamp }
```

This collection exists to fix the regression the review found (finding 5): the new restrictive `users` read rule (§6) denies reading other players' `users` docs, which would break the existing global-leaderboard query. Instead of loosening `users`, leaderboard data is **denormalized** into a world-readable collection carrying only the three non-PII fields the leaderboard table renders. Write rules (§6) ensure a user can only write their **own** `leaderboard/{uid}` row and only when they are an `active` non-pending account, so a pending student cannot inject a fabricated score. This keeps `users` fully private while preserving the global leaderboard.

- Who writes it: `saveProfile` (§7.1) writes `leaderboard/{uid}` **in addition to** `users/{uid}`, but only for accounts that are leaderboard-eligible (adults, or `active` students; never pending students, never legacy-before-backfill). Writing a denormalized row is cheap and idempotent (`setDoc merge`).
- **How `saveProfile` knows it is eligible (resolves finding 1).** `saveProfile` lives in the `<script type="module">` block and receives only the profile field list (`{name,best,level,grade,speed,heroColor,…,musicOn}`, verified ~line 659) — it has **no** `role`/`status` in scope, because those live in the separate main-script IIFE and are never passed in. We do **not** thread `role`/`status` into the persisted `profile` literal (that would risk persisting new fields onto `users` and fighting the create-rule's `best == 0` on backfill). Instead we add an explicit eligibility flag on the cloud object:
  - New module-scope `let leaderboardEligible = false;` inside the Firebase module block, plus a new `MathQuestCloud` method `setLeaderboardEligible(bool)` that assigns it.
  - `saveProfile` reads this flag: it `setDoc`s `leaderboard/{uid}` **only if `leaderboardEligible === true`**. The `users/{uid}` write is unconditional (unchanged).
  - Call sites that set the flag (named explicitly): in `enterGame` (main script, ~line 1104), right after `loadProfile` resolves the role/status branch, call `cloud().setLeaderboardEligible(isAdult || studentStatus === 'active')` — i.e. `true` for adults and active students, `false` for pending students. Legacy docs are backfilled to `active` in the same branch (§7.4), so they set `true`. On the live pending→active transition (§5 `onMyStatus`), call `cloud().setLeaderboardEligible(true)` at the moment the student flips to active. In `logout()` (~line 1164) call `cloud().setLeaderboardEligible(false)` so a stale flag never leaks across sessions.
  - This keeps the `persistProgress` profile literal (~line 1198) **unchanged** (no `role`/`status` added there), so the `users` write shape is untouched and the create-rule's `best == 0` constraint is never disturbed.
- Who reads it: the leaderboard query (§7.6) now reads `leaderboard`, not `users`.

### 4.6 Lookups / indexes

- **Adult sends a userid invite — resolve the target:** `getDoc(usernames/{userid})` → `{uid,email}`; key lookup, no index. (Email invite: no read; the adult writes the raw email, §3.1 E2.)
- **Adult sends/upserts an invite:** `setDoc(links/{linkId}, {...status:'invited'})` — write by deterministic (userid) or adult-namespaced (email) id, no index.
- **Student resolves a fallback code:** `getDoc(linkCodes/{CODE})` — key lookup, no index.
- **Student creates a code-request (fallback):** `setDoc(links/{self}_{adultUid}, {...status:'requested'})` — no index.
- **Adult lists their students across both directions:** `query(links, where('adultUid','==',me), where('status','in',['invited','accepted','requested','approved']))` — composite index on (`adultUid`, `status`). Declared in `firestore.indexes.json` (committed, not deployed in this phase; so this exact `in`+equality index is untested against the live project/emulator in this phase — flagged in §11). The `in` list widens from 2 values to 4 but the index shape (adultUid asc, status asc) is unchanged.
- **Student lists invites addressed to them:**
  - *userid invites and code-requests* (carry a concrete `studentUid`): `query(links, where('studentUid','==',me), where('status','in',['invited','requested']))` — composite index on (`studentUid`, `status`). A code-request the student created will show here too (its own `requested` row), which the UI labels "waiting for the adult"; invites (`invited`) show an **Accept** button.
  - *email invites* (`studentUid: null`): `query(links, where('targetKind','==','email'), where('targetValue','==',myEmail), where('status','==','invited'))` — composite index on (`targetKind`, `targetValue`, `status`). The student's own email comes from their auth/`users` record and is passed **normalized** as `myEmail = lower(trim(storedEmail))` so it matches the lowercased stored `targetValue` (§3.1.1 touch point (d); the stored email is verbatim-case, so normalizing only at the storage/match points keeps all four touch points in agreement).
- **Adult shows each linked student's name/status:** `getDoc(users/{studentUid})` — allowed because a link exists (§6). Each such read, and each `users` read generally, incurs one `exists()`/`get()` on the link path inside `adultLinkedTo` — a per-read rule-eval/billing cost documented in §6.
- **Student checks their own authorization:** read their own `users/{uid}.status` (self-read; see live `watchMyStatus(uid, cb)`, §7.1).
- **Global leaderboard:** `query(leaderboard, orderBy('best','desc'), limit)` — world-readable, no per-document deny (see §4.5).

## 5. Offline / Pending-Student Experience

- **Offline (Firebase unavailable):** unchanged. The game already falls back to local cache + local leaderboard. Role/status logic is skipped entirely; the user plays solo exactly as today. No regression. (Verified: `enterGame` role-branching is only on the online path; offline uses `getCached(uid)`.)
- **Pending student (online, not yet approved):** after login they land on a **"Waiting for approval"** screen (`#pendingApproval`) that:
  - **(PRIMARY) Pending-invite list.** Lists any invites addressed to them, each showing the inviting adult's name and an **Accept** button. The list is the union of two queries (§4.6): invites with a concrete `studentUid == me` and `status == 'invited'`, plus email invites matched by `targetValue == myEmail` / `status == 'invited'` (where `myEmail` is the student's own email normalized to `lower(trim(...))` so it matches the lowercased stored `targetValue`, §3.1.1). Tapping **Accept** runs `onAcceptInvite(linkId, targetKind, adultUid, adultRole)` (§7.3), which flips that link to `accepted` (or, for an email invite, creates the canonical `accepted` link) and the student's own `users.status` to `active`.
  - **(FALLBACK) "Have a code? Enter it" field** to type an adult's shareable code when no invite arrived. Submitting runs `onRequestByCode()` (§7.3), which creates a `status:'requested'` link the adult later approves. The screen reflects a pending code-request as "Sent — waiting for your adult to approve."
  - A **"Play solo for now"** button.
  `enterGame`'s pending branch sets an explicit **`state = "pending"`** while this screen is up (see §7.3), so `onMyStatus`'s `state !== 'playing'` immediate-transition test is unambiguous and the value cannot collide with the existing state-switched handlers. The real, verified state-switched strings are **`auth`, `start`, `playing`, `battle`, `levelClear`, `gameOver`, `paused`** (the pause string is `"paused"` — lines ~2171/2204; there is **no** `"pause"`/`"countdown"` state, those are only element ids / `el` handles). `"pending"` is unique against all of them (resolves carried-forward NIT, §13 finding 2). "Play solo for now" leaves the pending screen and runs the normal game loop (which sets `state = "playing"` on start), so the pending state is only held while actually waiting. Accepting an invite and entering a fallback code are both **post-login actions** (the student is already authenticated; §7.3). Playing solo uses the normal game loop but: (a) their score is **not** written to `leaderboard/{uid}` — `enterGame` set `leaderboardEligible = false` for a pending student (§4.5), so `saveProfile` skips the leaderboard write, and the rules reject a pending write anyway, (b) they are flagged as pending in their profile.
- **pending → active live transition (fully specified; resolves findings 6 and the review's finding 2).** The `onSnapshot` is created in the module script, but its callback must read/write main-script state (`state`, `justActivated`). Those variables live inside the main-script IIFE and are **not reachable from the module**. So the ownership is split deliberately:
  - `watchMyStatus(uid, cb)` (§7.1) is a **thin module wrapper** that takes `uid` **as a parameter** (the module keeps no current-uid; `currentUid` is a main-script var ~line 775): `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db, USERS, uid), s => cb(s.data())); }` — **returns the unsubscribe function**, or a **safe no-op** `()=>{}` when auth/db/uid is missing (so `unsubMyStatus?.()` is always callable). It contains no game logic. (Resolves carried-forward MEDIUM, §13 finding 1.)
  - The callback passed in is a **main-script function `onMyStatus(data)`** (defined in the main IIFE, §7.3), so it can touch `state`, set/read `justActivated`, and call `hideAllOverlays()` / `el.start.classList.add("show")`. `enterGame` wires it with the id it already has: `unsubMyStatus = cloud().watchMyStatus(currentUid, onMyStatus)`.
  - `onMyStatus(data)` body: when `data.status === 'active'`:
    - If **not mid-game** (`state !== 'playing'`): transition immediately — `cloud().setLeaderboardEligible(true)`, `hideAllOverlays()`, `el.start.classList.add("show")`, `state = 'start'`, then `unsubMyStatus?.(); unsubMyStatus = null;` (one-shot).
    - If **mid-game** (`state === 'playing'`): do **not** interrupt. Set `cloud().setLeaderboardEligible(true)` (so the student's next save lands on the leaderboard) and set the main-script flag `justActivated = true`. Leave the run alone and keep the snapshot subscribed until the deferred transition fires.
  - **Deferred transition hook sites (named).** The two natural screen boundaries are the existing `gameOver()` (~line 2005) and `levelCleared()` (the level-clear handler, ~line 1971). Note: `levelClear` in this file is **not** a function — it is an element id (`#levelClear`), a DOM handle (`el.levelClear`), and the state string `state = "levelClear"`; the actual handler is named `levelCleared()`. Add this 3-line check to the **end of both** functions:
    ```js
    if (justActivated) {
      justActivated = false;
      hideAllOverlays(); el.start.classList.add("show"); state = "start";
      unsubMyStatus?.(); unsubMyStatus = null;
    }
    ```
    (It runs after the overlay those functions show is set up; it supersedes the game-over/level-clear screen only when the student was just activated mid-run.)
  - `justActivated` is a **main-script module-scope `let justActivated = false;`** declared alongside `let unsubMyStatus = null;` (§7.3).
  - The snapshot is **always unsubscribed**: in `logout()` (§7.5), on the immediate transition above, and in the deferred `justActivated` check — so there is no listener leak across sessions.
- **Active student / any adult:** adults go to the **Approval desk** (`#approvalDesk`) which now has: an **"Invite a student"** input (userid or email) + Send button (primary); a list of their students across both directions showing each one's state — **invite: sent / accepted** for invites they sent, and **requested (Approve/Deny)** for code-requests from students; and their own shareable **link code** shown for the fallback. Adults can still open the game. Active students go straight to the existing start screen.

## 6. Security Rules Strategy (`firestore.rules`) + Attack-Case Reasoning

Rules are the **only** real protection: the Firebase web config (`apiKey`, project id, etc.) is public in `index.html` (verified, `firebaseConfig` literal ~lines 527–537, `apiKey` ~line 528) and cannot be hidden in a static site. Anyone can instantiate the SDK against project `mathquest-ca395`. Therefore every invariant below is enforced server-side in rules, never by trusting the client. In particular, the client is untrusted even when it "follows the flow": the rules independently re-verify that an inviting/approving adult is really an adult, that a student is not acting as their own adult, that a self-created `users` doc has a zero score and no approver, that a student can only activate off a link an adult genuinely addressed to them, and that an email invite can only be accepted by the account whose own email matches the invite.

The **activating write differs by direction**, so each direction has its own guarded branch:
- **Invite (adult-initiated):** the **student** performs the activating `users` self-update, allowed only when a matching adult-authored `links` doc addressed to this student exists; the student simultaneously moves that link `invited→accepted`.
- **Code-request (fallback, student-initiated):** the **adult** performs the activating `users` update, allowed only when an `approved` link to this adult exists — the approved design's adult branch, now scoped to `source:'code'`.

```
// =====================================================================
// MathQuest firestore.rules — ATTACK-CASE INDEX (both flows, old + new)
// Every invariant is enforced below; this block enumerates what is blocked
// and where. OLD = carried from the single-flow design; NEW = introduced by
// the bidirectional invite flow.
//
//  A1 (OLD) student self-approves via users self-update
//           -> self-update branch (1) forbids changing own status; the only
//              student status change is the invite-accept branch (2), which
//              requires a real adult-authored 'invited' link (none exists for a
//              self-forged invite, see N1/N4).
//  A2 (OLD) student self-approves via self-link chain (fake linkCodes 'teacher'
//           -> self links -> self approve) -> blocked at linkCodes.create
//              (callerRoleIs), links.create code-branch (studentUid!=adultUid),
//              and users adult-update (auth.uid!=uid & callerRoleIs).
//  A3 (OLD) studentUid == adultUid self-link -> links.create inequality deny.
//  A4 (OLD) cross-user users read -> read = isSelf || adultLinkedTo only.
//  A5 (OLD) fabricated score at users.create -> students forced best==0,
//              status=='pending', approvedBy==null.
//  A6 (OLD) role escalation on update -> role immutable on ALL update branches.
//  A7 (OLD) pending student writes a leaderboard row -> leaderboard write
//              requires users.status=='active' (or non-student).
//  A8 (OLD) adult over-writes a student's profile under cover of approval
//           -> onlyStatusAndApprover() diff limited to status/approvedBy/updated.
//  A9 (OLD) adult approves a student with no approved link -> adult-update (3)
//              requires approvedLinkExists() (exists()-guarded).
// --- NEW invite-flow attack cases ---
//  N1 student FORGES an invite 'from' a fake adult to self-activate
//       -> links.create invite-branch (a) requires isSelf(adultUid) AND
//          callerRoleIs(['teacher','parent']); a student is neither, so they
//          cannot author an 'invited' link. No link => users accept branch (2)
//          fails acceptableInviteExists => cannot activate.
//  N2 adult invites a student, then the STUDENT escalates via the accept write
//       -> users accept branch (2) is diff-limited to status/approvedBy/updated
//          (onlyStatusAndApprover), role immutable, status forced 'active'. The
//          student rides the accept to active ONLY; no role/score/other change.
//  N3 student ACCEPTS an invite that NAMES A DIFFERENT student
//       -> links accept branch (c) requires, for a userid invite,
//          existing().studentUid == auth.uid; for an email invite,
//          existing().targetValue == callerEmail(). users accept branch (2)
//          independently re-checks via acceptableInviteExists. Someone else's
//          invite cannot be accepted.
//  N4 a NON-ADULT sends invites -> links.create invite-branch (a) requires
//          callerRoleIs(['teacher','parent']); a student is denied.
//  N5 adult forges an invite 'from' another adult -> links.create invite-branch
//          requires isSelf(incoming().adultUid); email-invite id must be
//          'email_'+auth.uid+'_*'. An adult cannot name a different adultUid.
//  N6 student flips a DIFFERENT student's 'invited' link to 'accepted'
//          -> links accept branch (c) requires incoming().studentUid==auth.uid
//          and the userid/email addressee check; mirrors N3 at the links layer.
// =====================================================================
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
    // the caller's own stored email (from their users doc), LOWERCASED — for
    // email-invite matching. The stored email is verbatim-case (signup writes it
    // raw, index.html ~608/~612), while the invite id/targetValue are stored
    // lowercased (branch (a)); .lower() here is the single accept-side
    // normalization point (§3.1.1) so both sides compare the lowercased form.
    function callerEmail() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.email.lower();
    }

    // ---- usernames: unique userid -> {uid,email}. Create once; readable so
    //      login resolves userid->email AND an adult resolves a userid invite
    //      to a uid. Never mutate someone else's.
    match /usernames/{userid} {
      allow read: if true;                         // pre-auth login + userid-invite resolution
      allow create: if isSelf(incoming().uid);     // you can only claim for yourself
      allow update, delete: if false;              // immutable in Phase 1
    }

    // ---- linkCodes: adult discovery table (uid + role only, no PII). FALLBACK only.
    //      The creator must actually BE the adult whose role they claim.
    match /linkCodes/{code} {
      allow read: if signedIn();                   // student resolves a fallback code
      allow create: if isSelf(incoming().adultUid)
                    && incoming().role in ['teacher','parent']
                    && callerRoleIs([incoming().role]);   // real adult of that role
      allow update, delete: if false;
    }

    // ---- leaderboard/{uid}: denormalized world-readable scores (no PII beyond
    //      display name). Only an ACTIVE account may write its OWN row.  [A7]
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
      allow read: if isSelf(uid) || adultLinkedTo(uid);           // [A4]

      // Create own doc. role fixed at creation; students start pending with a
      // zero score and no approver (prevents a fabricated leaderboard entry). [A5]
      allow create: if isSelf(uid)
        && incoming().role in ['student','teacher','parent']
        && (incoming().role != 'student' ||
             (incoming().status == 'pending'
              && incoming().best == 0
              && incoming().approvedBy == null));

      // (1) Self update — profile/progress only, NO escalation. [A1][A6]
      allow update: if isSelf(uid)
        && incoming().role == existing().role              // role immutable
        && incoming().status == existing().status          // can't self-approve here
        && incoming().approvedBy == existing().approvedBy; // can't self-set approver

      // (2) Self update — ACCEPT AN INVITE (adult-initiated flow). The STUDENT
      //     activates themselves, but ONLY off a real adult-authored invite
      //     addressed to them. role immutable; diff limited to
      //     status/approvedBy/updated; approvedBy must be the inviting adult. [N1][N2][N3]
      allow update: if isSelf(uid)
        && existing().role == 'student'
        && existing().status == 'pending'
        && incoming().status == 'active'
        && incoming().role == existing().role
        && acceptableInviteExists(uid, incoming().approvedBy)   // invite from THIS adult, addressed to THIS student
        && onlyStatusAndApprover(uid);

      // (3) Adult update — APPROVE A CODE-REQUEST (fallback flow). A REAL,
      //     LINKED adult (not the student) flips the student to active. [A8][A9]
      allow update: if signedIn()
        && request.auth.uid != uid                         // no self-approval
        && callerRoleIs(['teacher','parent'])              // caller is a real adult
        && existing().role == 'student'
        && approvedLinkExists(uid, request.auth.uid)       // approved code-link to THIS adult
        && incoming().status == 'active'
        && incoming().role == existing().role
        && incoming().approvedBy == request.auth.uid
        && onlyStatusAndApprover(uid);

      allow delete: if false;
    }

    // ---- links/{linkId}
    match /links/{linkId} {
      allow read: if signedIn()
        && (isSelf(existing().studentUid) || isSelf(existing().adultUid)
            || (existing().targetKind == 'email'                // email invite addressed to me
                && existing().targetValue == callerEmail()));

      // (a) ADULT sends an INVITE (primary). Creator must BE a real adult. No
      //     self-links. userid invites carry a resolved studentUid + deterministic
      //     id; email invites carry studentUid:null + adult-namespaced id. [N1][N4][N5]
      allow create: if isSelf(incoming().adultUid)
        && callerRoleIs(['teacher','parent'])
        && incoming().source == 'invite'
        && incoming().status == 'invited'
        && incoming().createdBy == request.auth.uid
        && incoming().adultUid != incoming().studentUid   // studentUid null for email => true
        && incoming().targetKind in ['userid','email']
        && (
             (incoming().targetKind == 'userid'
               && incoming().studentUid is string
               && linkId == incoming().studentUid + '_' + incoming().adultUid)
             ||
             (incoming().targetKind == 'email'
               && incoming().studentUid == null
               && linkId == 'email|' + request.auth.uid + '|' + incoming().targetValue
               && incoming().targetValue == incoming().targetValue.lower())  // email stored lowercased
           );

      // (b) STUDENT requests a link by CODE (fallback). No self-links; the
      //     adultUid must be an existing teacher/parent. [A2][A3]
      allow create: if isSelf(incoming().studentUid)
        && incoming().source == 'code'
        && incoming().studentUid != incoming().adultUid
        && incoming().status == 'requested'
        && incoming().createdBy == request.auth.uid
        && linkId == incoming().studentUid + '_' + incoming().adultUid
        && exists(/databases/$(database)/documents/users/$(incoming().adultUid))
        && get(/databases/$(database)/documents/users/$(incoming().adultUid)).data.role in ['teacher','parent'];

      // (c) STUDENT accepts a USERID INVITE addressed to them (deterministic id
      //     already == studentUid_adultUid): 'invited' -> 'accepted'. [N3][N6]
      allow update: if existing().status == 'invited'
        && existing().targetKind == 'userid'
        && existing().studentUid == request.auth.uid      // addressee is the caller
        && incoming().status == 'accepted'
        && incoming().adultUid == existing().adultUid
        && incoming().studentUid == existing().studentUid
        && incoming().targetKind == existing().targetKind;

      // (c2) STUDENT accepts an EMAIL INVITE by CREATING the canonical link doc
      //      links/{auth.uid}_{adultUid} in 'accepted'. The student proves the
      //      email invite exists and is addressed to THEIR email via
      //      emailInviteToMe(). The original 'email_...' doc is left as-is
      //      (declinable later); all lookups use this canonical id. [N3][N6]
      allow create: if isSelf(incoming().studentUid)
        && incoming().source == 'invite'
        && incoming().targetKind == 'email'
        && incoming().status == 'accepted'
        && incoming().studentUid != incoming().adultUid
        && linkId == incoming().studentUid + '_' + incoming().adultUid
        && emailInviteToMe(incoming().adultUid);          // a matching 'invited' email invite exists for my email

      // (d) ADULT decides a CODE-REQUEST addressed to them: 'requested' -> approved/denied.
      allow update: if isSelf(existing().adultUid)
        && existing().status == 'requested'
        && incoming().status in ['approved','denied']
        && incoming().studentUid == existing().studentUid
        && incoming().adultUid == existing().adultUid;

      // (e) EITHER party may DECLINE a pending invite ('invited' -> 'denied').
      allow update: if existing().status == 'invited'
        && incoming().status == 'denied'
        && incoming().adultUid == existing().adultUid
        && (isSelf(existing().adultUid)
            || (existing().targetKind == 'userid' && existing().studentUid == request.auth.uid)
            || (existing().targetKind == 'email' && existing().targetValue == callerEmail()));

      allow delete: if false;
    }

    function adultLinkedTo(studentUid) {
      // An adult may read a student's users doc once a deterministic-id link to
      // them exists in a non-denied state. (Email invites use an 'email_...' id
      // and are not accepted until the student stamps their uid; the adult does
      // not read the invitee's users doc before accept — they show the typed
      // email — so this helper need not cover the email-id case.)
      return signedIn()
        && exists(/databases/$(database)/documents/links/$(studentUid + '_' + request.auth.uid))
        && get(/databases/$(database)/documents/links/$(studentUid + '_' + request.auth.uid)).data.status != 'denied';
    }
    function approvedLinkExists(studentUid, adultUid) {
      // exists()-guarded. Used by the ADULT code-request approval branch (3).
      let path = /databases/$(database)/documents/links/$(studentUid + '_' + adultUid);
      return exists(path) && get(path).data.status == 'approved';
    }
    function acceptableInviteExists(studentUid, adultUid) {
      // exists()-guarded. Used by the STUDENT invite-accept users branch (2).
      // The student performs link-accept (branch (c)) FIRST, so by the time this
      // runs the link exists naming this student+adult in 'invited'/'accepted'.
      let path = /databases/$(database)/documents/links/$(studentUid + '_' + adultUid);
      return exists(path)
        && get(path).data.adultUid == adultUid
        && get(path).data.studentUid == studentUid
        && get(path).data.status in ['invited','accepted'];
    }
    function emailInviteToMe(adultUid) {
      // exists()-guarded. Reconstructs the email-invite id from the CALLER'S OWN
      // email, so a student can only prove an email invite that was addressed to
      // THEIR email. callerEmail() returns the LOWERCASED stored email (§3.1.1),
      // matching the lowercased id/targetValue written at invite time (branch (a)),
      // so mixed-case emails (e.g. "Alice@Example.com") accept correctly. The
      // lowercased email is used verbatim in the id (no lossy slug, §4.4). Used by
      // the email-invite accept-create branch (c2).
      let path = /databases/$(database)/documents/links/$('email|' + adultUid + '|' + callerEmail());
      return exists(path)
        && get(path).data.adultUid == adultUid
        && get(path).data.status == 'invited'
        && get(path).data.targetKind == 'email'
        && get(path).data.targetValue == callerEmail();
    }
    function onlyStatusAndApprover(uid) {
      // every field except status/approvedBy/updated must be unchanged
      return incoming().diff(existing()).affectedKeys().hasOnly(['status','approvedBy','updated']);
    }
  }
}
```

> **Accept ordering note (invite flow).** Both invite kinds converge on a canonical `links/{studentUid}_{adultUid}` doc that all lookups (`acceptableInviteExists`, `adultLinkedTo`) key on, written **before** the activating `users` write:
> - **userid invite:** the invite doc already *is* `links/{studentUid}_{adultUid}` (studentUid was resolved at send). Accept = (1) `updateDoc(link, status:'accepted')` via branch (c); then (2) `updateDoc(users/{me}, status:'active', approvedBy:adultUid)` via branch (2). `acceptableInviteExists` finds the link in `accepted`.
> - **email invite:** the invite doc is `links/email|{adultUid}|{email}` with `studentUid:null`. Accept = (1) `setDoc(links/{me}_{adultUid}, {source:'invite', targetKind:'email', status:'accepted', studentUid:me, adultUid, ...})` via branch (c2) — the rule reconstructs the `email|...` id from the caller's own email (`emailInviteToMe`) and confirms it exists `invited` addressed to that email; then (2) the same `users` activate via branch (2), which now finds the canonical link. The original `email|...` doc is left `invited` (the adult still sees "sent"; either party may later decline it).
>
> In both cases the client issues the link write first, then the `users` write. If the second write fails the canonical link exists but the student stays `pending`; re-accept is idempotent (branch (2) re-runs; `acceptableInviteExists` still passes on the `accepted` link; branch (c2) `setDoc` is an overwrite of the same canonical doc). One client code path (`onAcceptInvite`, §7.3) handles both by branching on `targetKind`.

### 6.4 Attack-case reasoning pass (ids A*/N* match the comment block atop `firestore.rules`)

**OLD cases (carried forward, both flows):**

- **A1 — Student self-approves via `users` self-update.** Self-`update` branch (1) requires `incoming().status == existing().status`, so a student can never change their own `status` there. The only student status change is the invite-accept branch (2), which requires a real adult-authored invite via `acceptableInviteExists`/`emailInviteToMe`; a student cannot author such an invite (N1/N4). Blocked. ✔
- **A2 — Student self-approves via a self-link chain.** Chain: create `linkCodes/{C}` claiming `role:'teacher'` for own uid → create a self `links` doc → approve it as own "adult" → flip own `users.status`. Blocked at every step: `linkCodes` create requires `callerRoleIs([incoming().role])` (a student's `users.role` is `student`, so claiming `teacher` fails); the `links` code-request branch (b) requires `studentUid != adultUid` and the target `users.role in ['teacher','parent']`; the `users` adult-approval branch (3) requires `request.auth.uid != uid` and `callerRoleIs(['teacher','parent'])`. Three independent gates. Blocked. ✔
- **A3 — `studentUid == adultUid` self-link.** `links` code-request branch (b) requires `incoming().studentUid != incoming().adultUid`; the invite branch (a) requires `incoming().adultUid != incoming().studentUid`. Blocked. ✔
- **A4 — Student reads another user's `users` doc.** `users` read allows `isSelf(uid)` or `adultLinkedTo(uid)`. A student is never the adult in a link to another user, so cross-student reads fail. Blocked. ✔ (Cross-player scores remain visible only via the world-readable `leaderboard` collection, which holds no PII beyond the chosen display name.)
- **A5 — Fabricated score at `users` create.** Student `create` forces `best == 0 && approvedBy == null && status == 'pending'`. Blocked. ✔
- **A6 — Role escalation on update.** Every `users` update branch (1)(2)(3) requires `incoming().role == existing().role`. `role` is immutable post-creation across both flows. Blocked. ✔
- **A7 — Pending student writes a leaderboard row.** `leaderboard` write requires the writer's own `users` doc to be a non-student **or** `status == 'active'`. A pending student's write is denied. Blocked. ✔
- **A8 — Adult over-writes a student's profile under cover of approval.** `onlyStatusAndApprover` restricts the adult's branch-(3) diff to `status`/`approvedBy`/`updated`; the same guard restricts the student's branch-(2) accept diff. Neither can change score/grade/name/role. ✔
- **A9 — Adult approves a student with no approved link.** Branch (3) calls `approvedLinkExists(uid, auth.uid)` (exists()-guarded, requires `status == 'approved'`). No approved code-link → clean deny. And an adult can only move a link to `approved` on a link whose `adultUid` is themselves (branch (d)). Blocked. ✔
- **Self-declared adult at signup.** `create` pins `role in {...}`; a user *may* choose `teacher`/`parent` (self-declared adult) — accepted for Phase 1 and bounded (power only over students who accept the adult's invite or whose code-request the adult approves). Known limitation. ✔ (noted)

**NEW invite-flow cases:**

- **N1 — Student forges an invite "from" a fake adult to self-activate.** The only write that activates a student via the invite path is `users` branch (2), gated by `acceptableInviteExists` (userid invite) or, for the canonical link it reads, a prior branch-(c)/(c2) link write. To get an `invited` link the student would need `links` branch (a), which requires `isSelf(incoming().adultUid) && callerRoleIs(['teacher','parent'])` — a student is not an adult and cannot set `adultUid` to themselves-as-adult. No `invited` link can be authored by a student, so `acceptableInviteExists` finds nothing (or branch (c2)'s `emailInviteToMe` finds no adult-authored email invite). Blocked. ✔
- **N2 — Adult invites a student; the student escalates via the accept write.** The student's accept `users` write (branch (2)) is diff-limited by `onlyStatusAndApprover` to `status`/`approvedBy`/`updated`, forces `status == 'active'`, and keeps `role` immutable. `approvedBy` must equal an `adultUid` that `acceptableInviteExists` confirms authored the link to this student. The student rides the accept to `active` **only** — no role bump, no score change, no arbitrary approver. Blocked beyond intended activation. ✔
- **N3 — Student accepts an invite that names a different student.** For a **userid** invite, both `links` branch (c) and `users` `acceptableInviteExists` require the link's `studentUid == request.auth.uid`. For an **email** invite, branch (c2) + `emailInviteToMe` reconstruct the invite id from the **caller's own** `callerEmail()` and require `targetValue == callerEmail()`, so the student can only prove an invite addressed to their own email. Accepting someone else's invite fails. Blocked. ✔
- **N4 — A non-adult sends invites.** `links` invite branch (a) requires `callerRoleIs(['teacher','parent'])`. A student (or anyone whose own `users.role` is not teacher/parent) creating an `invited` link is denied. Blocked. ✔
- **N5 — Adult forges an invite "from" another adult.** Branch (a) requires `isSelf(incoming().adultUid)`; the email-invite id must be `'email|' + request.auth.uid + '|...'` (adult-owned prefix) and the userid-invite id must be `studentUid_adultUid` with `adultUid == self`. An adult cannot author a link naming a different `adultUid`. Blocked. ✔
- **N6 — Student flips a different student's `invited` link to `accepted`.** `links` accept branch (c) requires `existing().studentUid == request.auth.uid` (userid) and `incoming().studentUid == request.auth.uid`; the email path (c2) is a create keyed on the caller's own uid guarded by `emailInviteToMe`. A student cannot accept into another student's identity. Blocked. ✔
- **Queue/invite spam.** A stranger guessing a code can create a `requested` link (queue noise, zero capability, adult declines). An adult can send `invited` invites to arbitrary userids/emails (invite noise on the student's pending screen, zero capability until the student accepts). Rate-limiting both is deferred (needs a Function). Documented limitation. ⚠

> Rule-eval cost note: the `users` read rule calls `adultLinkedTo` (one `exists()`+`get()`); the invite-accept (`acceptableInviteExists`), email-accept (`emailInviteToMe`), and code-approval (`approvedLinkExists`) branches each run one `exists()`+`get()`; `callerRoleIs`/`callerEmail` each add one `get()`. These are per-operation document reads billed against the project, all on low-fanout write/one-off paths. The only high-fanout read path (the leaderboard) was deliberately moved off `users` to `leaderboard`, which has a trivial `allow read: if true` and no cross-doc lookups.

### Known limitations (explicit, for reviewer)

- **Self-declared adult role at signup.** Phase 1 has no verification that a "teacher"/"parent" is really an adult. Standard for an MVP and bounded: an adult only gains power over students who **accept** their invite or whose **code-request** they approve. Real verification (email domain, invite tokens, admin) is a later phase.
- **No invite/code-request rate limiting** (queue/invite-list spam, both directions). Needs a Cloud Function — deferred to keep Phase 1 build-free.
- **Email invites are unauthenticated claims of an address.** An adult can invite any email string; only the account whose own stored email matches can accept (enforced by `emailInviteToMe`). An invite to an email that no account owns simply never resolves — harmless. No email is sent by Phase 1 (no Functions); the invite surfaces in-app when the matching student logs in.
- **Leaderboard denormalization is eventually-consistent.** A player's `leaderboard` row is written alongside their `users` write in `saveProfile`; a partial failure could leave the two briefly out of sync. Acceptable for a cosmetic leaderboard; no correctness or auth impact.
- **Composite indexes untested this phase.** `firestore.indexes.json` is committed but not deployed, so the three `links` composite indexes — `(adultUid, status)`, `(studentUid, status)`, and `(targetKind, targetValue, status)` — behind the adult's student-list, the student's invite-list, and the email-invite-match queries are not verified against the live project/emulator in this step.

## 7. Client Changes in `index.html` (exact regions)

All edits stay inline / in the existing module; no new files loaded in the browser except Firebase (already loaded). Line numbers are approximate current-state anchors (file is **3656 lines**) — **locate by function name / element id, not line number.**

### 7.1 Firebase module block (`<script type="module">`, ~lines 516–688)
- Add collection constants `LINKS = "links"`, `LINKCODES = "linkCodes"`, `LEADERBOARD = "leaderboard"` beside the existing `USERS`/`USERNAMES` (~line 565).
- Import additions from the already-used firestore module URL (`https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js`, ~line 524): add `updateDoc`, `where`, `onSnapshot`. (**Do not** import `deleteField` — no Phase 1 flow deletes a field; resolves finding 9.)
- Extend `signup(...)` (~lines 585–620) to accept `role`. Validate `role in {student,teacher,parent}`. On student signup write `status:'pending', approvedBy:null, best:0`. On adult signup generate a unique `linkCode`, write `linkCodes/{code}` (`{adultUid, role}`), and store `linkCode` + `role` on the `users` doc. The `usernames/{id}` mapping keeps its existing `{uid, email}` shape (unchanged); its `email` field is now also read by the userid-invite resolver (§4.2) — no field added.
- **Keep `onAuthChange` thin.** The listener callback (~line 576) stays `{uid, name}` exactly as today. Role/status branching happens in `enterGame`, which already calls `loadProfile(uid)` and has the full doc — no second read, no extended payload (resolves finding 8).
- Add new `MathQuestCloud` methods (helpers normalize inputs: userids via the existing `normalizeUserid`, emails via `lower(trim(...))`):
  - **Invite (primary, adult-side):** `inviteStudent({ identifier })` — classify `identifier` as a **userid** (passes `validUserid`) or an **email** (contains `@`).
    - userid: `getDoc(usernames/{userid})` → `{uid}`; `setDoc(links/{studentUid}_{me}, { studentUid, adultUid:me, adultRole:myRole, source:'invite', targetKind:'userid', targetValue:userid, status:'invited', createdBy:me, createdAt:serverTimestamp(), decidedAt:null })`. If `usernames/{userid}` does not exist, return `{ok:false, error:"No student with that user ID."}` (the adult can retry with an email instead).
    - email: `const key = lower(trim(email));` `setDoc(links/"email|"+me+"|"+key, { studentUid:null, adultUid:me, adultRole:myRole, source:'invite', targetKind:'email', targetValue:key, status:'invited', createdBy:me, createdAt:serverTimestamp(), decidedAt:null })`. No lookup, no email sent (Phase 1); the invite surfaces in-app when that student logs in.
  - **Invite list (adult-side):** `listMyStudents()` — `query(links, where('adultUid','==',me), where('status','in',['invited','accepted','requested','approved']))`; for each row with a concrete `studentUid` `getDoc(users/{studentUid})` for the name; rows without a name (un-accepted email invite) display `targetValue` (the email) and state "sent". Returns `[{linkId, studentUid, name|email, source, status}]`.
  - **Accept (primary, student-side):** `acceptInvite({ linkId, targetKind, adultUid, adultRole })` — the caller passes `adultRole` from the invite row it already read in `listMyInvites` (see below; the email invite doc carries `adultRole`). Branch on `targetKind`:
    - userid: `updateDoc(links/{linkId}, { status:'accepted', decidedAt:serverTimestamp() })` then `updateDoc(users/{me}, { status:'active', approvedBy:adultUid, updated:serverTimestamp() })`.
    - email: `const myEmail = lower(trim(storedEmail));` `setDoc(links/{me}_{adultUid}, { studentUid:me, adultUid, adultRole:(adultRole ?? null), source:'invite', targetKind:'email', targetValue:myEmail, status:'accepted', createdBy:me, createdAt:serverTimestamp(), decidedAt:serverTimestamp() })` (canonical doc, rule branch (c2)) then the same `users` activate. **Carry the real `adultRole` through from the email invite the student is accepting** (the `email|…` invite row the student read in `listMyInvites` exposes `adultRole` — the student may read it via the `links` read rule's email-addressee clause). If for any reason it is absent, write `null` — never the literal `'?'`. The field is typed `'teacher'|'parent'|null` (§4.4), and rules do not read `adultRole` on branch (c2), so this is a cosmetic/schema-consistency fix only (resolves iteration-5 NIT 2). `myEmail` is `lower(trim(storedEmail))` so the written `targetValue` matches the lowercased invite (§3.1.1).
    - Order is links-write-first in both (§6 accept-ordering note); returns `{ok}` and the `onMyStatus` snapshot fires the UI transition.
  - **Pending-invite list (student-side):** `listMyInvites({ myEmail })` — the caller passes `myEmail` **already normalized** as `lower(trim(storedEmail))` (§3.1.1 touch point (d)) so it matches the lowercased stored `targetValue`; union of `query(links, where('studentUid','==',me), where('status','in',['invited','requested']))` and `query(links, where('targetKind','==','email'), where('targetValue','==',myEmail), where('status','==','invited'))`; returns `[{linkId, adultUid, adultName, adultRole, targetKind, status}]` (adult name via `getDoc(users/{adultUid})`, readable because the invite links them; `adultRole` is read straight off the invite row so `acceptInvite` can carry it onto the canonical email-accept doc, §7.1 Accept). Rows with `status:'invited'` render **Accept**; a student's own `requested` row renders "waiting for approval".
  - **Code fallback (student-side):** `requestByCode({ code })` — `getDoc(linkCodes/{CODE})` → `{adultUid}`; `setDoc(links/{me}_{adultUid}, { studentUid:me, adultUid, adultRole:<code.role>, source:'code', targetKind:null, targetValue:null, status:'requested', createdBy:me, createdAt:serverTimestamp(), decidedAt:null })`. Unknown code → `{ok:false, error:"That code didn't match an adult."}`.
  - **Approve/deny code-request (adult-side):** `approveStudent({ studentUid })` — `updateDoc(links/{studentUid}_{me}, { status:'approved', decidedAt:serverTimestamp() })` then `updateDoc(users/{studentUid}, { status:'active', approvedBy:me, updated:serverTimestamp() })`. `denyStudent({ studentUid })` — `updateDoc(links/{studentUid}_{me}, { status:'denied', decidedAt:serverTimestamp() })` only (no `users` write).
  - **Status watch:** `watchMyStatus(uid, cb)` — a **thin module wrapper** taking `uid` **as a parameter** (the module keeps no current-uid; resolves carried-forward MEDIUM §13 finding 1): `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db, USERS, uid), s => cb(s.data())); }`. Returns the unsubscribe function, or a **safe no-op** `()=>{}` when `db`/`uid` is missing (offline). Holds **no** game logic — the real callback `onMyStatus` lives in the main script because it must touch `state`/`justActivated` (§5, §7.3).
  - `myLinkCode()` — getter returning the adult's own `linkCode` (for the fallback display).
  - `backfillRole(uid)` — `setDoc(users/{uid}, { role:'student', status:'active', approvedBy:null }, { merge:true })`. A **distinct** write (not `saveProfile`, whose fixed destructure cannot carry `role`/`status`/`approvedBy`); goes through the self-`update` rule branch (1), not `create`, so the `best==0` create constraint is untouched (resolves carried-forward NIT §13 finding 4; see §7.4).
- Add a module-scope eligibility flag and setter (resolves finding 1): `let leaderboardEligible = false;` beside the other module state, and a `MathQuestCloud` method `setLeaderboardEligible(bool) { leaderboardEligible = !!bool; }`. `saveProfile` cannot read `role`/`status` (they are not in its scope — see §4.5), so this flag is the mechanism it branches on.
- Extend `saveProfile` (~line 659): keep the unconditional `setDoc(users/{uid}, …)` exactly as today, then **if `leaderboardEligible === true`** also `setDoc(leaderboard/{uid}, {name, best, level, updated: serverTimestamp()}, {merge:true})`. This is the only writer of the denormalized leaderboard row. Do **not** add `role`/`status` to the destructured `saveProfile` signature or to the `persistProgress` profile literal (~line 1198) — the `users` write shape stays unchanged.

### 7.2 Auth UI HTML (`#auth` overlay, ~lines 342–367)
- Add a **role picker** to the Sign Up pane (`#signupPane`): three selectable buttons (I'm a Student / Parent / Teacher) styled with the existing `.grade-btn`/`.color-swatch` pattern and pastel palette. Default = Student.
- Add two new overlays after `#auth` (sibling `<div class="overlay">` blocks):
  - `#pendingApproval` (student waiting screen): explanation; a **pending-invite list** container `#inviteList` (one row per invite with the inviting adult's name + an **Accept** button; the student's own code-request rows render as "waiting for approval"); a **fallback** "Have a code? Enter it" input `#codeInput` + **Send** button; a **"Play solo for now"** button.
  - `#approvalDesk` (adult screen): an **"Invite a student"** input `#inviteInput` (placeholder "user ID or email") + **Send** button; a **student list** container `#studentList` (one row per link showing name-or-email and state: invites → "sent"/"accepted"; code-requests → "requested" with **Approve**/**Deny** buttons); the adult's own shareable **link code** displayed (for the fallback); an **"Open game"** button.
- Reuse existing CSS classes (`.overlay`, `.btn`, `.btn.big`, `.auth-hint`, `.grade-btn`). Add a small `.role-btn`/`.student-row`/`.invite-row` CSS block in the `/* Auth */` CSS region (~lines 151–171) matching the rounded-card pastel style (`"Comic Sans MS"`/`"Trebuchet MS"`, rounded cards, existing shadow).

### 7.3 Auth flow JS (functions ~lines 1053–1175)
- `doSignup` (~1073): read the selected role, pass it to `cloud().signup`.
- `enterGame` (~1104): after `loadProfile`/`getCached`/default, branch **explicitly into three cases** (resolves carried-forward NIT §13 finding 3 — the default literal `{name,best:0,level:1,grade:1,speed:2}` and the cached object both carry **no** `role`, so they must land in the third branch, not fall through):
  1. **adult** — `profile.role in {teacher,parent}` → `cloud().setLeaderboardEligible(true)`, render & show `#approvalDesk`.
  2. **pending student** — `profile.role === 'student' && profile.status === 'pending'` → `cloud().setLeaderboardEligible(false)`, render & show `#pendingApproval`, set **`state = "pending"`** (explicit waiting-screen state; §5), wire the Accept/code/solo handlers, and `unsubMyStatus = cloud().watchMyStatus(currentUid, onMyStatus)` (pass `currentUid`, §7.1 MEDIUM fix).
  3. **everything else** — active student, legacy doc with no `role`, cache-only object, or the default literal → `cloud().setLeaderboardEligible(true)`, run the existing start-screen path (`hideAllOverlays()` + `el.start.classList.add("show")`), and if `profile.role` is missing fire the legacy backfill (`cloud().backfillRole(currentUid)`, §7.4).
- Add new handler functions near here: `showPending()`, `showApprovalDesk()`, `renderMyInvites()` (student), `renderMyStudents()` (adult), `onAcceptInvite(linkId, targetKind, adultUid, adultRole)` (the `adultRole` comes from the invite row rendered by `renderMyInvites`/`listMyInvites`; forwarded to `cloud().acceptInvite(...)` so the canonical email-accept doc carries the real role instead of a `'?'` placeholder, §7.1), `onRequestByCode()`, `onInviteStudent()` (adult), `onApprove(uid)`, `onDeny(uid)`, `playSolo()`, and `onMyStatus(data)`.
- **Main-script module-scope state (declared together, inside the main IIFE):** `let unsubMyStatus = null;` and `let justActivated = false;`. These are main-script variables precisely because `onMyStatus` and the deferred hooks need to touch `state`/`justActivated`, which the module cannot see (see §5).
- `onMyStatus(data)` is the main-script callback handed to `cloud().watchMyStatus(currentUid, ...)`; it owns the `state === 'playing'` branch, the `justActivated` flag, and the immediate-vs-deferred transition logic exactly as specified in §5. Both the invite-accept (student's own write) and the code-approval (adult's write) flip `users.status` to `active`, so this one snapshot drives the UI transition for **both** flows.
- The deferred transition is a 3-line `if (justActivated) {…}` block added to the **end of `gameOver()` (~2005) and `levelCleared()` (~1971)** — the two named hook sites (§5). (The level-clear handler is named `levelCleared()`; `levelClear` by itself is only an element id / `el.levelClear` handle / `state = "levelClear"` string — do not hook those.)
- `onAcceptInvite(...)`, `onRequestByCode()`, and `onInviteStudent()` are all **post-login actions** (the actor is already authenticated, so the `signedIn()`-gated reads/writes on `linkCodes`/`links`/`usernames` pass). The pending screen's code/accept controls are never used pre-auth.

### 7.4 Legacy backfill
- In `enterGame`'s third branch, if a loaded profile has no `role`, treat it as `student`/`active` in memory and persist the backfill via the **distinct** `cloud().backfillRole(currentUid)` method (§7.1) doing `setDoc(users/{uid}, { role:'student', status:'active', approvedBy:null }, { merge:true })`. **Not** `saveProfile** — `saveProfile`'s destructure has a fixed field list with no `role`/`status`/`approvedBy`, so routing the backfill through it would silently drop all three fields (resolves carried-forward NIT §13 finding 4). The backfill goes through the self-`update` rule branch (1) (not the constrained `create` branch), so an existing player's score is untouched. Old players are grandfathered without a flag day. (The cache-only/default-literal case also lacks `role`; it hits the same backfill once online — harmless because the merge write only adds the three missing fields.)

### 7.5 Startup listener (`startAuthListener`, ~line 3634) and `showAuth`/overlay plumbing
- **Register the two new overlays so they are actually hidden (resolves the HIGH finding 2).** Add to the `el` map (~line 701 region): `pendingApproval: document.getElementById("pendingApproval")` and `approvalDesk: document.getElementById("approvalDesk")`. Then add `el.pendingApproval, el.approvalDesk` to the hardcoded array inside `hideAllOverlays()` (~line 2392):
  ```js
  [el.auth, el.start, el.battle, el.levelClear, el.gameOver, el.pause, el.countdown,
   el.help, el.scratch, el.leaderboard, el.pendingApproval, el.approvalDesk]
    .forEach(o => o.classList.remove("show"));
  ```
  This is required — `hideAllOverlays` sweeps a hardcoded element list, **not** `.overlay.show`; without this edit the new overlays would stay stuck on top of the game. (We keep the hardcoded-array approach rather than refactoring to `querySelectorAll('.overlay.show')`, to avoid an unrelated behavior change to existing transitions.)
- `showAuth` (~line 1053) calls `hideAllOverlays()` already, so once the two overlays are in that array they are correctly cleared on the auth transition. No other change to `showAuth`.
- `startAuthListener` unchanged in structure; `enterGame` does the role branching, so the listener stays thin. Offline branch unchanged — pending/role logic is never reached offline. Add `unsubMyStatus?.(); unsubMyStatus = null;` and `cloud().setLeaderboardEligible(false);` to `logout()` (~line 1164) so the status snapshot is detached and the eligibility flag is cleared on sign-out (no listener leak, no stale flag across sessions; §5, §4.5).

### 7.6 Leaderboard
- Add a `MathQuestCloud` method (or repoint `topScores`) to read the denormalized collection: `query(collection(db, LEADERBOARD), orderBy('best','desc'), limit(max))` instead of querying `users` (resolves the regression in finding 5 — the restrictive `users` read rule no longer blocks the leaderboard). `renderLeaderboardRows` (~line 2030) is unchanged; it already reads `name/best/level`, which the `leaderboard` docs carry. Pending students never appear because they never get a `leaderboard` row written.
- **The live leaderboard-write trigger (name it, no new wiring needed).** The denormalized row is written whenever the existing `submitBestToCloud()` runs: `submitBestToCloud()` (~line 1211) → `persistProgress({ immediate: true })` (~lines 1197–1207) → `cloud().saveProfile(currentUid, profile)`. `submitBestToCloud()` is already called from `levelCleared()` (~line 1995), `gameOver()` (~line 2010), and `showLeaderboard()` (~line 2050), so once `saveProfile` gains the `leaderboardEligible`-gated `leaderboard/{uid}` write (§7.1) **every** existing trigger also refreshes the denormalized row — no new call site is added. This is consistent with the "`saveProfile` is the only writer of the leaderboard row" claim (§4.5): all three triggers funnel through `saveProfile`.
- **Update the now-stale source comment.** The comment above `submitBestToCloud` (~line 1210) currently reads "...saving the profile also updates the global board, since **the leaderboard reads from `users/{uid}`**." Once the read is repointed to `leaderboard` (above) that justification is false. Change the comment to reference `leaderboard/{uid}` (e.g. "...the leaderboard reads from `leaderboard/{uid}`, which `saveProfile` writes alongside `users/{uid}`") so the source does not contradict the new design. Comment-only edit; no behavior change.

## 8. New Non-Client Files (committed, NOT deployed this phase)
- `firestore.rules` — the ruleset in §6.
- `firestore.indexes.json` — three `links` composite indexes: `(adultUid asc, status asc)` [adult student-list], `(studentUid asc, status asc)` [student invite-list], and `(targetKind asc, targetValue asc, status asc)` [email-invite match]. Each is an equality/`in` + equality query, so each needs its own composite index declaration.
- `firebase.json` — minimal config pointing `firestore.rules`/`firestore.indexes.json` (so a later `firebase deploy --only firestore:rules` is one command). No hosting block changed; GitHub Pages stays the host.

These are repo artifacts only; this step does **not** run `firebase deploy`/`login` and does not touch billing.

## 9. Testability
- **Security rules (unit-testable, highest value):** `@firebase/rules-unit-testing` against the Firestore emulator covers every attack case in §6.4 (A1–A9 + N1–N6). Key new assertions for the invite flow: a student cannot create an `invited` `links` doc (N1/N4); a non-matching student cannot accept a userid invite (N3) or create the canonical accepted doc for an email invite whose `targetValue != callerEmail()` (N3 email); an adult cannot author an invite with a different `adultUid` (N5); the student's accept `users` write is diff-limited and cannot change role (N2). Plus the carried-forward old assertions (self-link chain A2, create-rule A5, role immutability A6). Add `test/firestore.rules.test.js` in a later implementation step; the emulator needs no live project and no gcloud.
- **Client auth-flow logic:** the three-way role-branching in `enterGame`, the `justActivated` deferral rule, the identifier classifier (userid vs email) in `inviteStudent`, and the pure helpers (`validUserid`, email normalization, code generation, role validation) are unit-testable by extracting them as small pure functions; DOM-heavy paths are integration-tested manually against the emulator.
- **Manual integration (both directions):** signup as each role; (primary) adult invites by userid and by email → student sees the invite and accepts → flips to active; (fallback) student types the adult's code → adult approves → flips to active; verify live flip via `watchMyStatus` for both the on-pending-screen immediate transition and the mid-game deferral; leaderboard reads from `leaderboard` and excludes pending; logout detaches the snapshot; offline fallback still works with Firebase blocked.
- Hard-to-test smell check: none of the above requires the live project; everything runs on the emulator.

## 10. Out of Scope (Phase 1)
- AI agents / prompt-driven game builder / Vertex AI Gemini (later phase — the `links`/role model deliberately leaves Cloud Functions room and does not conflict).
- New question templates beyond the existing runner.
- Teacher-vs-parent capability differences, classes/groups, reporting dashboards.
- **Sending an actual email** for an email invite (needs a Cloud Function / mail provider) — Phase 1 surfaces invites in-app only.
- Server-side leaderboard *filtering logic beyond the active-only write guard*, invite/code-request rate limiting, adult identity verification.
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

## 12. Responses to the latest review findings (iteration 3)

Reviewed doc verdict: **CHANGES_REQUESTED** — 2 MEDIUM, 0 HIGH, 2 NITs. The security-rules strategy was accepted (self-approval chain closed at three gates, role immutable, leaderboard denormalized). Both blockers were underspecified client data-flow details.

- **Finding 1 — MEDIUM, `saveProfile` cannot see `role`/`status`; leaderboard write-guard unimplementable. ADDRESSED (fix (b)).** Chose the `setLeaderboardEligible(bool)` flag on `MathQuestCloud` over threading fields through the profile literal, because fix (a) would add `role`/`status` to the persisted `profile` object and risk disturbing the `users` write shape / the create-rule `best == 0` constraint. Specified: a module-scope `let leaderboardEligible = false;`, a `setLeaderboardEligible` setter, `saveProfile` gating the `leaderboard/{uid}` write on that flag, and the exact call sites that set it — `enterGame` (per role/status branch), the `onMyStatus` activation transition, and `logout()` (reset to false). The `persistProgress` profile literal (~line 1198) and the `saveProfile` signature are explicitly left unchanged. See §4.5 ("How `saveProfile` knows it is eligible"), §7.1 (flag + `saveProfile` bullet), §7.3 (`enterGame`), §7.5 (`logout`).
- **Finding 2 — MEDIUM, mid-game activation deferral references unnamed handlers / cross-scope variables. ADDRESSED.** Specified the split ownership: `watchMyStatus(cb)` is a thin module wrapper returning the unsubscribe (§7.1); the callback is a **main-script `onMyStatus(data)`** owning the `state === 'playing'` branch and the `justActivated` flag; `justActivated` and `unsubMyStatus` are declared together as main-script module-scope `let`s (§7.3). Named the deferred-transition hook sites — the 3-line `if (justActivated) {…}` block is added to the **end of `gameOver()` (~2005) and `levelCleared()` (~1971)**, with the exact snippet shown (§5, §7.3). (Corrected in this iteration from the wrong symbol `levelClear()`; see §13 finding 1.)
- **Finding 3 — NIT, line-anchor drift. ADDRESSED.** §6 `firebaseConfig` anchor corrected to ~527–537 (`apiKey` ~528). The "locate by function name / element id" instruction at §1/§7 already governs all anchors as approximate.
- **Finding 4 — NIT, clarify code-claim is post-login. ADDRESSED.** Noted in §5 and §7.3 that `onClaimCode()` is a post-login action (the student is authenticated, so the `signedIn()` read on `linkCodes` passes); no rule change needed.

## 13. Responses to the latest review findings (iteration 4)

Reviewed doc verdict: **CHANGES_REQUESTED** — 1 MEDIUM, 0 HIGH, 2 NITs. The security-rules strategy and the two cross-script client data-flow mechanisms (`leaderboardEligible` flag; `watchMyStatus` wrapper + main-script `onMyStatus`) were accepted. All three remaining findings concerned the precision of the client-edit anchors/names and were verified directly against `index.html`.

- **Finding 1 — MEDIUM, deferred-transition hook function named `levelClear()` instead of `levelCleared()`. ADDRESSED.** Verified in source: the level-clear handler is `function levelCleared()` at line 1971 (it sets `state = "levelClear"` internally and shows `el.levelClear`); there is no function `levelClear()` — that token is only an element id (`#levelClear`, line 439), a DOM handle (`el.levelClear`), and the state string. Renamed every **hook-function** reference from `levelClear()` to `levelCleared()` in §5, §7.3, and §12, and added an explicit note at each site that `levelClear` as an id/handle/state string is left untouched. Corrected the anchors to `gameOver()` ~2005 and `levelCleared()` ~1971 (both still "locate by name"). The mid-game activation correctness argument now hooks the real handler.
- **Finding 2 — NIT, `submitBestToCloud()` trigger and its stale comment unmentioned. ADDRESSED.** §7.6 now names the live leaderboard-write path `submitBestToCloud()` (~line 1211) → `persistProgress({ immediate: true })` → `cloud().saveProfile(currentUid, profile)`, and lists its existing call sites (`levelCleared()` ~1995, `gameOver()` ~2010, `showLeaderboard()` ~2050) so the implementer sees that no new write call site is added — the `leaderboardEligible`-gated `saveProfile` write (§7.1) reaches all of them. §7.6 also instructs updating the now-false comment at ~line 1210 ("the leaderboard reads from `users/{uid}`") to reference `leaderboard/{uid}` (comment-only, no behavior change). This is consistent with the §4.5 "`saveProfile` is the only writer" claim, which the review confirmed.
- **Finding 3 — NIT, pending-screen `state` value unspecified. ADDRESSED.** `enterGame`'s pending branch now sets an explicit **`state = "pending"`** while `#pendingApproval` is shown (§7.3), and §5 documents it so `onMyStatus`'s `state !== 'playing'` immediate-transition test is unambiguous and the value cannot collide with the existing state-switched handlers. (The verified state strings are `auth`/`start`/`playing`/`battle`/`levelClear`/`gameOver`/`paused` — see §14 carried-forward NIT; the earlier mention of `pause`/`countdown` here was corrected, those are element ids/handles, not states.) "Play solo for now" starts the normal loop (which sets `state = "playing"`), so `"pending"` is held only while actually waiting.

## 14. This iteration (iteration 5 — bidirectional linking + carried-forward residual findings)

This iteration makes the user-requested linking change and, in the same pass, applies the 4 residual findings from the last review (verdict CHANGES_REQUESTED: 1 MEDIUM + 3 NITs) that were still open. The security-rules *architecture* (self-approval closed at independent gates, role immutability, denormalized leaderboard, offline fallback, live `watchMyStatus` transition) is unchanged; only the linking surface and these four precision points changed.

### 14.1 The linking-mechanism change (user instruction)

- **Primary flipped to adult-initiated invite by userid/email.** §3 rewritten: a teacher/parent invites a student by userid or email (`links` doc `status:'invited'`); the student sees it on login and **accepts**, which activates them. §3.1 records the **email-resolution DECISION (E2 — address by raw identifier, student self-matches email, userid pre-resolved to a uid)** with its veto points, chosen as the simplest robust option that needs no email index and performs no email enumeration against the world-readable `usernames`.
- **Code demoted to fallback.** §3/§4.3: the adult's shareable `linkCode`/`linkCodes` table is retained but is now the student-initiated backup (`links` doc `status:'requested'` → adult approves). Both directions terminate in student `active`, linked to that adult.
- **Data model.** §4.2 notes `usernames` already carries `email` (no shape change) and is now also the userid→uid resolver. §4.4 reshapes `links` into one bidirectional record with `source`/`targetKind`/`targetValue` and the five-value `status` lifecycle, and defines the two id schemes (deterministic `studentUid_adultUid`; email `email|{adultUid}|{email}`). §4.6 lists the three new/updated queries and their indexes.
- **Security rules.** §6 adds a full **attack-case comment block atop `firestore.rules`** enumerating A1–A9 (old, both flows) and N1–N6 (new invite cases), then implements: a student invite-accept `users` self-update branch (2) gated by `acceptableInviteExists`/`emailInviteToMe` and `onlyStatusAndApprover`; the retained adult code-approval branch (3); and `links` branches (a) adult-invite, (b) student code-request, (c) userid-accept, (c2) email-accept-create, (d) adult decide, (e) decline. §6.4 walks every A*/N* case to a blocked verdict. All six original guarantees ((a)–(f) in the step brief) are preserved and extended across both flows; each new invite attack (forged invite, escalation-via-accept, cross-student accept, non-adult invite, forged-adultUid, cross-student link flip) is shown blocked.
- **UI.** §5/§7.2/§7.3: the student pending screen gains a **pending-invite list with Accept** (primary) plus the **enter-a-code fallback**; the adult desk gains an **invite-a-student input** and an **invite-status list** alongside the **approve code-request** surface and the fallback code display. §7.1 adds the matching `MathQuestCloud` methods (`inviteStudent`, `listMyStudents`, `acceptInvite`, `listMyInvites`, `requestByCode`, `approveStudent`/`denyStudent`).

### 14.2 Carried-forward residual findings (now applied in-spec)

- **(MEDIUM) `watchMyStatus(uid, cb)` takes `uid` as a param. APPLIED.** §7.1 and §5 specify `watchMyStatus(uid, cb){ if(!db||!uid) return ()=>{}; return onSnapshot(doc(db,USERS,uid), s=>cb(s.data())); }`, wired as `cloud().watchMyStatus(currentUid, onMyStatus)` (`currentUid` is the main-script var ~line 775). Returns a safe no-op unsubscribe when auth/db/uid is missing, so `unsubMyStatus?.()` is always callable.
- **(NIT) Verified state strings. APPLIED.** §5 and §13-finding-3 corrected to the verified set `auth, start, playing, battle, levelClear, gameOver, paused` (pause string is `"paused"`, ~2171/2204; no `"pause"`/`"countdown"` state). New state `"pending"` is unique.
- **(NIT) `enterGame` three explicit branches. APPLIED.** §7.3 states all three: adult (`role in {teacher,parent}`); pending student (`role=='student' && status=='pending'`); everything else incl. missing-role / cache-only / default literal `{name,best:0,level:1,grade:1,speed:2}` → active + legacy backfill.
- **(NIT) Legacy backfill via distinct `backfillRole(uid)`. APPLIED.** §7.1/§7.4 specify `MathQuestCloud.backfillRole(uid)` → `setDoc(users/{uid}, {role:'student',status:'active',approvedBy:null}, {merge:true})` through the self-`update` rule branch — **not** the fixed-signature `saveProfile` (which would drop the three fields).

### 14.3 Compatibility with later phases
The `links`/invite model, the role fields on `users`, and the `firestore.rules`/`firestore.indexes.json`/`firebase.json` artifacts are static-site + rules only; nothing here requires or conflicts with adding Firebase Cloud Functions + Gemini via Vertex AI in Phase 2 (e.g. sending a real invite email, or rate-limiting invites/code-requests, would be additive Functions work). The dead `deploy/` folder and `questions.js` logic were not touched.

## 15. Responses to the latest review findings (iteration 5 → fixed in iteration 6)

Reviewed doc verdict: **CHANGES_REQUESTED** — 1 MEDIUM + 2 NITs, 0 HIGH. The review accepted the full iteration-5 bidirectional security architecture (walked A1–A9 + N1–N6 to blocked; no privilege-escalation hole found) and all four carried-forward residual findings. Only the email-path feasibility and two polish points remained. All three are resolved below; no settled security section was re-litigated.

- **Finding 1 — MEDIUM, email-invite accept unreachable for non-all-lowercase emails (case-normalization mismatch). ADDRESSED (rule-side normalization, no migration).** The review correctly identified that the invite id/`targetValue` are stored lowercased (branch (a)) while `callerEmail()` returned the student's **verbatim-case** stored email (signup writes it raw — verified in source at `index.html` ~1075 `.trim()` only, ~608 `setDoc(unameRef,{uid,email})`, ~612 `users` write), so both `exists(path)` and `targetValue == callerEmail()` failed for any mixed-case email, and `listMyInvites`' `where('targetValue','==',myEmail)` never matched. It failed *closed* (no privilege hole) but broke the new PRIMARY email path for a common case. Fix: pin a **single email-normalization point** (`lower(trim(x))`) and apply it identically across all four touch points, now documented in the new **§3.1.1** table:
  - (a) stored `targetValue` — client writes `lower(trim(email))`; rule branch (a) still asserts `targetValue == targetValue.lower()` (unchanged).
  - (b) invite id — `'email|' + adultUid + '|' + lower(trim(email))` (unchanged; already lowercased).
  - (c) accept-side — **`callerEmail()` now returns `get(users/{auth.uid}).data.email.lower()`** (the one changed line in §6), so `emailInviteToMe`'s reconstructed id and its `targetValue == callerEmail()` check both use the lowercased form. This also repairs the branch (e) decline path, which shares `callerEmail()`.
  - (d) discovery query — `listMyInvites({ myEmail })` is called with `myEmail = lower(trim(storedEmail))` (§7.1), and `acceptInvite`'s email branch writes `targetValue: lower(trim(storedEmail))` onto the canonical doc.
  Chose the rule-side `.lower()` over lowercasing at signup because the latter touches a settled write and needs a one-time backfill; `.lower()` is local to the changed flow and uses the same operator branch (a) already relies on. No security property changed.

- **Finding 2 — NIT, `acceptInvite` email branch persisted `adultRole:'?'` placeholder. ADDRESSED.** `acceptInvite` now takes `adultRole` (carried from the `email|…` invite row the student read in `listMyInvites`, which exposes `adultRole` via the `links` email-addressee read clause) and writes it onto the canonical `links/{me}_{adultUid}` doc; if absent it writes `null`, never `'?'`. The `adultRole` field type widened to `'teacher'|'parent'|null` (§4.4). Rules do not read `adultRole` on branch (c2), so this is purely schema-consistency for `listMyStudents` rendering. Updated in §4.4, §7.1 (Accept + `listMyInvites` return shape), §7.3 (`onAcceptInvite` signature).

- **Finding 3 — NIT, `saveProfile` line anchor drift (~648 vs ~659). ADDRESSED.** Tightened both `saveProfile` anchors to **~659** (§4.5, §7.1). All other anchors were confirmed by the review to be within the "locate by name" tolerance; no further change needed.

### 15.1 Compatibility and scope (unchanged)
This iteration touched only §3.1.1 (new), §4.4 (`adultRole` type), §4.6 (email-query normalization note), §5 (`onAcceptInvite` call + normalized `myEmail`), §6 (`callerEmail()`/`emailInviteToMe` lowercase), §7.1 (`acceptInvite`/`listMyInvites`/`saveProfile` anchor), and §7.3 (`onAcceptInvite` signature). The security architecture, the bidirectional flow, the offline fallback, the denormalized leaderboard, role immutability, and the live `watchMyStatus` transition are all unchanged. Nothing conflicts with adding Firebase Cloud Functions + Gemini via Vertex AI in Phase 2. The dead `deploy/` folder and `questions.js` were not touched.

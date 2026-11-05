// Firestore rules tests. Run via the emulator (see README.md).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch } from "firebase/firestore";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-mathquest",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const seed = async (fn) => { let out; await env.withSecurityRulesDisabled(async (c) => { out = await fn(c.firestore()); }); return out; }; // resolves to fn's result
const D = (db, path) => doc(db, path);

const STU = "stuA", STU2 = "stuB", TEA = "teaA", PAR = "parA";
const MIXED = "Kid.Test@Example.com";
const user = (role, extra = {}) => ({
  uid: "x", name: "n", email: "e@x.com", best: 0, level: 1, grade: 1, speed: 2, role,
  status: role === "student" ? "pending" : "active",
  ...(role === "student" ? { approvedBy: null } : {}), ...extra,
});
const seedUsers = () => seed(async (db) => {
  await setDoc(D(db, `users/${STU}`), user("student", { uid: STU, email: MIXED }));
  await setDoc(D(db, `users/${STU2}`), user("student", { uid: STU2, email: "other@x.com" }));
  await setDoc(D(db, `users/${TEA}`), user("teacher", { uid: TEA }));
  await setDoc(D(db, `users/${PAR}`), user("parent", { uid: PAR }));
});
const useridInvite = (stu, adult, role = "teacher") => ({
  studentUid: stu, adultUid: adult, adultRole: role, source: "invite", targetKind: "userid",
  targetValue: "kid", status: "invited", createdBy: adult, createdAt: serverTimestamp(), decidedAt: null,
});
const emailInvite = (adult, email, role = "parent") => ({
  studentUid: null, adultUid: adult, adultRole: role, source: "invite", targetKind: "email",
  targetValue: email, status: "invited", createdBy: adult, createdAt: serverTimestamp(), decidedAt: null,
});
const seedLink = (id, data) => seed((db) => setDoc(D(db, `links/${id}`), data));
// Invite rate limit helpers. The quota doc id/day come from the UTC date (request.time on the server).
const utcDayKey = (d = new Date()) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const quotaDoc = (adult, count, linkId, over = {}) => ({ adultUid: adult, day: utcDayKey(), count, lastLinkId: linkId, ...over });
// Writes invite link + quota bump in ONE batch (what the client does). `opts` lets a test break exactly one field.
async function inviteBatch(db, adult, linkId, linkData, opts = {}) {
  const day = opts.day ?? utcDayKey();
  const qref = D(db, `inviteQuota/${opts.quotaId ?? `${adult}_${day}`}`);
  let count = opts.count;
  if (count === undefined) {
    let cur = 0;
    try { const s = await getDoc(D(db, `inviteQuota/${adult}_${utcDayKey()}`)); if (s.exists()) cur = s.data().count; } catch {}
    count = cur + 1;
  }
  const b = writeBatch(db);
  if (!opts.noQuota) b.set(qref, quotaDoc(adult, count, opts.lastLinkId ?? linkId, { day, ...(opts.quotaOver || {}) }));
  if (!opts.noLink) b.set(D(db, `links/${linkId}`), linkData);
  return b.commit();
}
const activate = (uid, by) => ({ status: "active", approvedBy: by, updated: serverTimestamp() });

// ---------------- 1. signup ----------------
test("1a student signup create (pending, best 0, approvedBy null)", async () => {
  await assertSucceeds(setDoc(D(as("n1"), "users/n1"), { ...user("student"), uid: "n1", created: serverTimestamp(), updated: serverTimestamp() }));
});
test("1b teacher and parent signup create (+ usernames + linkCodes)", async () => {
  const t = as("t1");
  await assertSucceeds(setDoc(D(t, "usernames/teach"), { uid: "t1", email: "t@x.com" }));
  await assertSucceeds(setDoc(D(t, "users/t1"), { ...user("teacher"), uid: "t1", linkCode: "ABC123" }));
  await assertSucceeds(setDoc(D(as("p1"), "users/p1"), { ...user("parent"), uid: "p1", linkCode: "XYZ789" }));
});

// ---------------- 2. legacy backfill ----------------
const legacy = (uid) => seed((db) => setDoc(D(db, `users/${uid}`), { uid, name: "old", email: "o@x.com", best: 12, level: 2, grade: 1, speed: 2 }));
test("2a legacy role-less doc backfill (client setDoc merge) succeeds", async () => {
  await legacy("old");
  await assertSucceeds(setDoc(D(as("old"), "users/old"), { role: "student", status: "active", approvedBy: null }, { merge: true }));
});
test("2b legacy owner saves normal progress after backfill (client saveProfile shape)", async () => {
  await legacy("old");
  const db = as("old");
  await assertSucceeds(setDoc(D(db, "users/old"), { role: "student", status: "active", approvedBy: null, updated: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(D(db, "users/old"), {
    uid: "old", name: "old", best: 99, level: 3, grade: 2, speed: 2, heroColor: null, heroHair: false,
    heroGender: "boy", gemMatchColor: false, megaGemsCollected: 0, ultraGemsCollected: 0,
    subject: "math", musicOn: true, updated: serverTimestamp(),
  }, { merge: true }));
});
test("2c legacy un-backfilled player CANNOT save progress (fails closed; backfill must run first)", async () => {
  await legacy("old");
  await assertFails(setDoc(D(as("old"), "users/old"), { uid: "old", name: "old", best: 99, updated: serverTimestamp() }, { merge: true }));
});

// ---------------- 3. userid invite full chain ----------------
test("3 userid invite -> accept link -> activate (full chain)", async () => {
  await seedUsers();
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  const s = as(STU);
  await assertSucceeds(updateDoc(D(s, `links/${STU}_${TEA}`), { status: "accepted", decidedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(D(s, `users/${STU}`), activate(STU, TEA)));
});

// ---------------- 4. email invite w/ mixed-case stored email ----------------
test("4 email invite -> canonical accepted link (c2) -> activate, mixed-case stored email", async () => {
  await seedUsers();
  const lc = MIXED.toLowerCase();
  await assertSucceeds(inviteBatch(as(PAR), PAR, `email|${PAR}|${lc}`, emailInvite(PAR, lc)));
  const s = as(STU);
  // client writes targetValue = lowercased auth email
  await assertSucceeds(setDoc(D(s, `links/${STU}_${PAR}`), {
    studentUid: STU, adultUid: PAR, adultRole: "parent", source: "invite", targetKind: "email",
    targetValue: lc, status: "accepted", createdBy: STU, createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(D(s, `users/${STU}`), activate(STU, PAR)));
  // student can read the email invite addressed to them (callerEmail lowercased)
  await assertSucceeds(getDoc(D(s, `links/email|${PAR}|${lc}`)));
});
test("4b email invite with non-lowercase id/targetValue is rejected at creation", async () => {
  await seedUsers();
  // positive control (same helper, lowercase) so the negative isolates the lowercase check
  await assertSucceeds(inviteBatch(as(PAR), PAR, `email|${PAR}|${MIXED.toLowerCase()}`, emailInvite(PAR, MIXED.toLowerCase())));
  await assertFails(inviteBatch(as(PAR), PAR, `email|${PAR}|${MIXED}`, emailInvite(PAR, MIXED)));
});

// ---------------- 5. code fallback ----------------
test("5 code fallback: linkCode -> request -> approve -> adult activates", async () => {
  await seedUsers();
  await assertSucceeds(setDoc(D(as(TEA), "linkCodes/ABC123"), { adultUid: TEA, role: "teacher" }));
  await assertSucceeds(getDoc(D(as(STU), "linkCodes/ABC123")));
  await assertSucceeds(setDoc(D(as(STU), `links/${STU}_${TEA}`), {
    studentUid: STU, adultUid: TEA, adultRole: "teacher", source: "code", targetKind: null, targetValue: null,
    status: "requested", createdBy: STU, createdAt: serverTimestamp(), decidedAt: null,
  }));
  const t = as(TEA);
  await assertSucceeds(updateDoc(D(t, `links/${STU}_${TEA}`), { status: "approved", decidedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(D(t, `users/${STU}`), activate(STU, TEA)));
});

// ---------------- 6. leaderboard ----------------
const row = () => ({ name: "n", best: 5, level: 1, updated: serverTimestamp() });
test("6 leaderboard: active student, teacher, parent write own; anyone reads", async () => {
  await seedUsers();
  await seed((db) => setDoc(D(db, `users/${STU}`), user("student", { uid: STU, status: "active", approvedBy: TEA })));
  await assertSucceeds(setDoc(D(as(STU), `leaderboard/${STU}`), row(), { merge: true }));
  await assertSucceeds(setDoc(D(as(TEA), `leaderboard/${TEA}`), row(), { merge: true }));
  await assertSucceeds(setDoc(D(as(PAR), `leaderboard/${PAR}`), row(), { merge: true }));
  await assertSucceeds(getDoc(D(anon(), `leaderboard/${STU}`)));
  await assertSucceeds(getDoc(D(as(STU2), `leaderboard/${TEA}`)));
});
test("6b legacy role-less player cannot write leaderboard until backfilled (client backfills first at login)", async () => {
  await legacy("old");
  await assertFails(setDoc(D(as("old"), "leaderboard/old"), row(), { merge: true }));
  await assertSucceeds(setDoc(D(as("old"), "users/old"), { role: "student", status: "active", approvedBy: null }, { merge: true }));
  await assertSucceeds(setDoc(D(as("old"), "leaderboard/old"), row(), { merge: true }));
});

// ---------------- 7. reads ----------------
// Phase 1b (A11): this test used to seed an `invited` link and assert the adult CAN read. That pinned the
// privacy hole (read before the student consents), so it now seeds `accepted`. The old behaviour is asserted
// as DENIED in the 1b tests below.
test("7 adult linked (accepted) to student reads student doc; self reads own", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, { ...useridInvite(STU, TEA), status: "accepted" });
  await assertSucceeds(getDoc(D(as(TEA), `users/${STU}`)));
  await assertSucceeds(getDoc(D(as(STU), `users/${STU}`)));
});

// ---------------- 8. A1/A2/A3 ----------------
test("8a A1 student self-approves by direct update", async () => {
  await seedUsers();
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { status: "active", updated: serverTimestamp() }));
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), activate(STU, TEA)));
});
test("8b A3 student creates self-link", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), `links/${STU}_${STU}`), {
    studentUid: STU, adultUid: STU, source: "code", targetKind: null, targetValue: null,
    status: "requested", createdBy: STU, createdAt: serverTimestamp(), decidedAt: null,
  }));
});
test("8c A2 student creates fake linkCodes claiming teacher", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), "linkCodes/FAKE01"), { adultUid: STU, role: "teacher" }));
});

// ---------------- 9. A4 ----------------
test("9 A4 cross-user and unauthenticated users read denied", async () => {
  await seedUsers();
  await assertFails(getDoc(D(as(STU2), `users/${STU}`)));
  await assertFails(getDoc(D(as(TEA), `users/${STU}`))); // adult, no link
  await assertFails(getDoc(D(anon(), `users/${STU}`)));
});

// ---------------- 10. A5 ----------------
test("10 A5 student create with best>0 / status active / approvedBy set", async () => {
  const db = as("n1");
  await assertFails(setDoc(D(db, "users/n1"), { ...user("student"), uid: "n1", best: 500 }));
  await assertFails(setDoc(D(db, "users/n1"), { ...user("student"), uid: "n1", status: "active" }));
  await assertFails(setDoc(D(db, "users/n1"), { ...user("student"), uid: "n1", approvedBy: TEA }));
  await assertFails(setDoc(D(db, "users/n1"), { ...user("student"), uid: "n1", role: "admin" }));
  await assertFails(setDoc(D(as("n2"), "users/n1"), { ...user("student"), uid: "n1" })); // other uid
});

// ---------------- 11. A6 / A10 ----------------
test("11a A6 role escalation on update (student->teacher, parent->teacher)", async () => {
  await seedUsers();
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { role: "teacher" }));
  await assertFails(updateDoc(D(as(PAR), `users/${PAR}`), { role: "teacher" }));
  // role change riding the invite-accept branch
  await seedLink(`${STU}_${TEA}`, { ...useridInvite(STU, TEA), status: "accepted" });
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { ...activate(STU, TEA), role: "teacher" }));
});
test("11b A10 legacy role-less doc via 1b: role teacher/parent denied", async () => {
  await legacy("old");
  const db = as("old");
  await assertFails(setDoc(D(db, "users/old"), { role: "teacher", status: "active", approvedBy: null }, { merge: true }));
  await assertFails(setDoc(D(db, "users/old"), { role: "parent", status: "active", approvedBy: null }, { merge: true }));
  await assertFails(setDoc(D(db, "users/old"), { role: "student", status: "active", approvedBy: TEA }, { merge: true }));
  await assertFails(setDoc(D(db, "users/old"), { role: "student", status: "pending", approvedBy: null }, { merge: true }));
});
test("11c A10 legacy backfill that also changes best fails", async () => {
  await legacy("old");
  await assertFails(setDoc(D(as("old"), "users/old"), { role: "student", status: "active", approvedBy: null, best: 99999 }, { merge: true }));
});
test("11d doc that already has a role cannot use 1b to change role/status", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), `users/${STU}`), { role: "student", status: "active", approvedBy: null }, { merge: true }));
  await assertFails(setDoc(D(as(TEA), `users/${TEA}`), { role: "student", status: "active", approvedBy: null }, { merge: true }));
});

// ---------------- 12. A7 ----------------
test("12 A7 pending student / other uid / extra keys on leaderboard", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), `leaderboard/${STU}`), row()));          // pending
  await assertFails(setDoc(D(as(TEA), `leaderboard/${STU}`), row()));          // someone else's row
  await assertFails(setDoc(D(as(TEA), `leaderboard/${TEA}`), { ...row(), extra: 1 }));
  await assertFails(setDoc(D(as(TEA), `leaderboard/${TEA}`), { ...row(), uid: TEA }));
  await assertFails(deleteDoc(D(as(TEA), `leaderboard/${TEA}`)));
});

// ---------------- 13. A8 / A9 ----------------
test("13a A9 adult updates student with no approved link", async () => {
  await seedUsers();
  await assertFails(updateDoc(D(as(TEA), `users/${STU}`), activate(STU, TEA)));
  // link exists but only 'requested' / 'invited'
  await seedLink(`${STU}_${TEA}`, { ...useridInvite(STU, TEA), source: "code", status: "requested" });
  await assertFails(updateDoc(D(as(TEA), `users/${STU}`), activate(STU, TEA)));
});
test("13b A8 adult update changes fields beyond status/approvedBy/updated", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, { ...useridInvite(STU, TEA), source: "code", status: "approved" });
  await assertFails(updateDoc(D(as(TEA), `users/${STU}`), { ...activate(STU, TEA), best: 99999 }));
  await assertFails(updateDoc(D(as(TEA), `users/${STU}`), { ...activate(STU, TEA), name: "hacked" }));
  await assertFails(updateDoc(D(as(TEA), `users/${STU}`), { ...activate(STU, TEA), role: "teacher" }));
});
test("13c student account attempts adult approval branch on another student", async () => {
  await seedUsers();
  await seedLink(`${STU2}_${STU}`, { ...useridInvite(STU2, STU), source: "code", status: "approved" });
  await assertFails(updateDoc(D(as(STU), `users/${STU2}`), activate(STU2, STU)));
});

// ---------------- 14. N1/N4/N5 ----------------
test("14a N1/N4 student creates an invite link", async () => {
  await seedUsers();
  // N4 is over-determined under the quota rule (a student also fails the quota write); the control proves the
  // identical batch shape works for an adult, so the failure is about the caller being a student.
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU2}_${TEA}`, useridInvite(STU2, TEA)));
  await assertFails(inviteBatch(as(STU), STU, `${STU2}_${STU}`, useridInvite(STU2, STU)));
  await assertFails(inviteBatch(as(STU), STU, `${STU}_${STU2}`, useridInvite(STU, STU2)));
  await assertFails(inviteBatch(as(STU), STU, `email|${STU}|a@b.com`, emailInvite(STU, "a@b.com")));
  await assertFails(setDoc(D(as(STU), `links/${STU2}_${STU}`), useridInvite(STU2, STU))); // bare write, no quota
});
test("14b N5 adult creates invite naming a different adultUid", async () => {
  await seedUsers();
  // control: correct invite by TEA with the same helper. N5 negatives below are over-determined (the quota
  // pairing also fails when the link names another adult) but the control isolates the helper itself.
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  await assertFails(inviteBatch(as(TEA), TEA, `${STU}_${PAR}`, useridInvite(STU, PAR)));
  await assertFails(inviteBatch(as(TEA), TEA, `email|${PAR}|a@b.com`, emailInvite(PAR, "a@b.com")));
  await assertFails(inviteBatch(as(TEA), TEA, `${STU2}_${TEA}`, { ...useridInvite(STU2, TEA), createdBy: PAR }));
});

// ---------------- 15. N3/N6 ----------------
test("15a N3/N6 student B accepts userid invite addressed to student A", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, useridInvite(STU, TEA));
  await assertFails(updateDoc(D(as(STU2), `links/${STU}_${TEA}`), { status: "accepted" }));
  // B tries to mint own accepted link for A's invite via code-style create
  await assertFails(setDoc(D(as(STU2), `links/${STU2}_${TEA}`), {
    studentUid: STU2, adultUid: TEA, source: "invite", targetKind: "userid", targetValue: "kid",
    status: "accepted", createdBy: STU2, createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
  }));
});
test("15b N3 student accepts an email invite addressed to a different email", async () => {
  await seedUsers();
  await seedLink(`email|${PAR}|someone.else@x.com`, emailInvite(PAR, "someone.else@x.com"));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${PAR}`), {
    studentUid: STU, adultUid: PAR, source: "invite", targetKind: "email", targetValue: "someone.else@x.com",
    status: "accepted", createdBy: STU, createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
  }));
  await assertFails(getDoc(D(as(STU), `links/email|${PAR}|someone.else@x.com`)));
});
test("15c N3 student activates with approvedBy = adult who has no invite to them", async () => {
  await seedUsers();
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), activate(STU, TEA)));
  // invite from PAR exists, but student claims TEA
  await seedLink(`${STU}_${PAR}`, useridInvite(STU, PAR, "parent"));
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), activate(STU, TEA)));
  // invite to another student does not help
  await seedLink(`${STU2}_${TEA}`, useridInvite(STU2, TEA));
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), activate(STU, TEA)));
});

// ---------------- 16. N2 ----------------
test("16 N2 student accepting also changes role/best in same update", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, { ...useridInvite(STU, TEA), status: "accepted" });
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { ...activate(STU, TEA), best: 5000 }));
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { ...activate(STU, TEA), role: "teacher" }));
  await assertSucceeds(updateDoc(D(as(STU), `users/${STU}`), activate(STU, TEA))); // control
});

// ---------------- 17. usernames / links / linkCodes ----------------
test("17a usernames: no update/delete, no create for another uid, public read", async () => {
  await seed((db) => setDoc(D(db, "usernames/kid"), { uid: STU, email: "k@x.com" }));
  await assertFails(updateDoc(D(as(STU), "usernames/kid"), { email: "z@x.com" }));
  await assertFails(deleteDoc(D(as(STU), "usernames/kid")));
  await assertFails(setDoc(D(as(STU2), "usernames/new"), { uid: STU, email: "k@x.com" }));
  await assertSucceeds(getDoc(D(anon(), "usernames/kid")));
});
test("17b links and linkCodes delete denied; linkCodes update denied", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, useridInvite(STU, TEA));
  await seed((db) => setDoc(D(db, "linkCodes/ABC123"), { adultUid: TEA, role: "teacher" }));
  await assertFails(deleteDoc(D(as(TEA), `links/${STU}_${TEA}`)));
  await assertFails(deleteDoc(D(as(STU), `links/${STU}_${TEA}`)));
  await assertFails(deleteDoc(D(as(TEA), "linkCodes/ABC123")));
  await assertFails(updateDoc(D(as(TEA), "linkCodes/ABC123"), { role: "parent" }));
  await assertFails(getDoc(D(anon(), "linkCodes/ABC123")));
});

// =====================================================================
// Phase 1b
// =====================================================================
const codeReq = (stu, adult, extra = {}) => ({
  studentUid: stu, adultUid: adult, adultRole: "teacher", source: "code", targetKind: null, targetValue: null,
  status: "requested", createdBy: stu, createdAt: serverTimestamp(), decidedAt: null, ...extra,
});
const emailAccepted = (stu, adult, email, extra = {}) => ({
  studentUid: stu, adultUid: adult, adultRole: "parent", source: "invite", targetKind: "email", targetValue: email,
  status: "accepted", createdBy: stu, createdAt: serverTimestamp(), decidedAt: serverTimestamp(), ...extra,
});
const legacyActive = (uid, extra = {}) => seed((db) => setDoc(D(db, `users/${uid}`),
  { uid, name: "oldkid", email: "Old.Kid@x.com", best: 40, level: 3, grade: 2, speed: 2, role: "student", status: "active", approvedBy: null, ...extra }));

// ---------------- 1b. privacy: adult reads only after consent (A11) ----------------
test("1b-a A11 adult cannot read an invited-but-not-accepted student (userid invite)", async () => {
  await seedUsers();
  await inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA));
  await assertFails(getDoc(D(as(TEA), `users/${STU}`)));
  await assertSucceeds(updateDoc(D(as(STU), `links/${STU}_${TEA}`), { status: "accepted", decidedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(D(as(TEA), `users/${STU}`))); // control: same adult/student, only the status changed
});
test("1b-b A11 adult cannot read a student with a 'requested' or 'denied' link", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, codeReq(STU, TEA));
  await assertFails(getDoc(D(as(TEA), `users/${STU}`)));
  await seedLink(`${STU}_${TEA}`, { ...codeReq(STU, TEA), status: "denied" });
  await assertFails(getDoc(D(as(TEA), `users/${STU}`)));
});
test("1b-c A11 email invite not yet accepted exposes nothing; canonical accept does", async () => {
  await seedUsers();
  const lc = MIXED.toLowerCase();
  await inviteBatch(as(PAR), PAR, `email|${PAR}|${lc}`, emailInvite(PAR, lc));
  await assertFails(getDoc(D(as(PAR), `users/${STU}`)));
  await assertSucceeds(setDoc(D(as(STU), `links/${STU}_${PAR}`), emailAccepted(STU, PAR, lc)));
  await assertSucceeds(getDoc(D(as(PAR), `users/${STU}`)));
});
test("1b-d adult can read after code-request approval, and still cannot read an unrelated student", async () => {
  await seedUsers();
  await assertSucceeds(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { studentName: "kid" })));
  await assertFails(getDoc(D(as(TEA), `users/${STU}`)));
  await assertSucceeds(updateDoc(D(as(TEA), `links/${STU}_${TEA}`), { status: "approved", decidedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(D(as(TEA), `users/${STU}`)));
  await assertFails(getDoc(D(as(TEA), `users/${STU2}`)));   // unrelated student
  await assertFails(getDoc(D(as(PAR), `users/${STU}`)));    // unrelated adult
});

// ---------------- name labels + key allowlists (A16) ----------------
test("1b-e studentName on code request: 40 ok, 41 / non-string / extra key rejected", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { studentName: "x".repeat(41) })));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { studentName: 5 })));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { studentName: "k", bonus: 1 })));
  await assertSucceeds(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { studentName: "x".repeat(40) })));
});
test("1b-f adultName on invite: 40 ok, 41 / non-string / extra key rejected (control each time via valid batch)", async () => {
  await seedUsers();
  const id = `${STU}_${TEA}`;
  await assertFails(inviteBatch(as(TEA), TEA, id, { ...useridInvite(STU, TEA), adultName: "x".repeat(41) }));
  await assertFails(inviteBatch(as(TEA), TEA, id, { ...useridInvite(STU, TEA), adultName: 7 }));
  await assertFails(inviteBatch(as(TEA), TEA, id, { ...useridInvite(STU, TEA), bonus: 1 }));
  await assertSucceeds(inviteBatch(as(TEA), TEA, id, { ...useridInvite(STU, TEA), adultName: "x".repeat(40) }));
});
test("1b-g (c2) canonical email accept rejects extra keys", async () => {
  await seedUsers();
  const lc = MIXED.toLowerCase();
  await seedLink(`email|${PAR}|${lc}`, emailInvite(PAR, lc));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${PAR}`), emailAccepted(STU, PAR, lc, { studentName: "x" })));
  await assertSucceeds(setDoc(D(as(STU), `links/${STU}_${PAR}`), emailAccepted(STU, PAR, lc)));
});
test("1b-h names cannot be rewritten by (c) accept, (d) approve/deny, (e) decline", async () => {
  await seedUsers();
  const inv = { ...useridInvite(STU, TEA), adultName: "Teach" };
  await seedLink(`${STU}_${TEA}`, inv);
  await assertFails(updateDoc(D(as(STU), `links/${STU}_${TEA}`), { status: "accepted", decidedAt: serverTimestamp(), adultName: "Evil" }));
  await assertFails(updateDoc(D(as(TEA), `links/${STU}_${TEA}`), { status: "denied", decidedAt: serverTimestamp(), adultName: "Evil" }));
  await assertFails(updateDoc(D(as(STU), `links/${STU}_${TEA}`), { status: "denied", decidedAt: serverTimestamp(), adultName: "Evil" }));
  await assertSucceeds(updateDoc(D(as(STU), `links/${STU}_${TEA}`), { status: "denied", decidedAt: serverTimestamp() })); // control
  await seedLink(`${STU2}_${TEA}`, codeReq(STU2, TEA, { studentName: "kid" }));
  await assertFails(updateDoc(D(as(TEA), `links/${STU2}_${TEA}`), { status: "approved", decidedAt: serverTimestamp(), studentName: "Evil" }));
  await assertSucceeds(updateDoc(D(as(TEA), `links/${STU2}_${TEA}`), { status: "approved", decidedAt: serverTimestamp() })); // control
});

// ---------------- Item 2: legacy-ACTIVE student links to a grown-up ----------------
test("2-userid legacy active student accepts a userid invite (link only), adult then reads progress", async () => {
  await seedUsers(); await legacyActive("old");
  await assertSucceeds(inviteBatch(as(TEA), TEA, `old_${TEA}`, useridInvite("old", TEA)));
  await assertFails(getDoc(D(as(TEA), "users/old")));
  await assertSucceeds(updateDoc(D(as("old"), `links/old_${TEA}`), { status: "accepted", decidedAt: serverTimestamp() }));
  // the pending->active users write is NOT used (and cannot be: rule (2) needs status pending)
  await assertFails(updateDoc(D(as("old"), "users/old"), activate("old", TEA)));
  const s = await assertSucceeds(getDoc(D(as(TEA), "users/old")));
  assert.equal(s.data().best, 40);
});
test("2-email legacy active student accepts an email invite (canonical link), adult reads progress", async () => {
  await seedUsers(); await legacyActive("old");
  const lc = "old.kid@x.com";
  await assertSucceeds(inviteBatch(as(PAR), PAR, `email|${PAR}|${lc}`, emailInvite(PAR, lc)));
  await assertSucceeds(setDoc(D(as("old"), `links/old_${PAR}`), emailAccepted("old", PAR, lc)));
  await assertSucceeds(getDoc(D(as(PAR), "users/old")));
});
test("2-code legacy active student requests by code; adult approves; adult reads progress", async () => {
  await seedUsers(); await legacyActive("old");
  await assertSucceeds(setDoc(D(as(TEA), "linkCodes/ABC123"), { adultUid: TEA, role: "teacher" }));
  await assertSucceeds(setDoc(D(as("old"), `links/old_${TEA}`), codeReq("old", TEA, { studentName: "oldkid" })));
  await assertSucceeds(updateDoc(D(as(TEA), `links/old_${TEA}`), { status: "approved", decidedAt: serverTimestamp() }));
  // (rule (3) would still allow an approvedBy rewrite on an already-active student; the client skips that write, see approveStudent)
  await assertSucceeds(getDoc(D(as(TEA), "users/old")));
});
test("2-role-less legacy doc: code approval leaves the link approved, adult users write is denied (client must skip it)", async () => {
  await seedUsers(); await legacy("old");
  await assertSucceeds(setDoc(D(as(TEA), "linkCodes/ABC123"), { adultUid: TEA, role: "teacher" }));
  await assertSucceeds(setDoc(D(as("old"), `links/old_${TEA}`), codeReq("old", TEA)));
  await assertSucceeds(updateDoc(D(as(TEA), `links/old_${TEA}`), { status: "approved", decidedAt: serverTimestamp() }));
  await assertFails(updateDoc(D(as(TEA), "users/old"), activate("old", TEA)));
  await assertSucceeds(getDoc(D(as(TEA), "users/old")));
});
test("2-guards pending student still cannot write leaderboard; student cannot approve themselves via a link", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), `leaderboard/${STU}`), row()));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${TEA}`), codeReq(STU, TEA, { status: "approved" })));
  await assertFails(updateDoc(D(as(STU), `users/${STU}`), { role: "parent" }));
});

// ---------------- Item 4: invite quota (A12-A15) ----------------
const qpath = (adult, day = utcDayKey()) => `inviteQuota/${adult}_${day}`;
test("4-limit 30 invites succeed, the 31st fails and the count stays 30", async () => {
  await seedUsers();
  const t = as(TEA);
  for (let i = 1; i <= 30; i++) {
    await assertSucceeds(inviteBatch(t, TEA, `s${i}_${TEA}`, useridInvite(`s${i}`, TEA)));
  }
  await assertFails(inviteBatch(t, TEA, `s31_${TEA}`, useridInvite("s31", TEA), { count: 31 }));
  await assertFails(inviteBatch(t, TEA, `s31_${TEA}`, useridInvite("s31", TEA), { count: 30 })); // no bump
  const q = await seed((db) => getDoc(D(db, qpath(TEA))));
  assert.equal(q.data().count, 30);
  const l = await seed((db) => getDoc(D(db, `links/s31_${TEA}`)));
  assert.equal(l.exists(), false);
});
test("4-dup re-inviting an existing id does not burn quota", async () => {
  await seedUsers();
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  await assertFails(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  const q = await seed((db) => getDoc(D(db, qpath(TEA))));
  assert.equal(q.data().count, 1);
});
test("4-pairing invite without quota, quota without invite, one bump for two links all fail", async () => {
  await seedUsers();
  const t = as(TEA);
  await assertFails(setDoc(D(t, `links/${STU}_${TEA}`), useridInvite(STU, TEA)));                            // invite, no quota
  await assertFails(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA), { noLink: true }));         // quota, no invite
  await assertFails(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA), { noQuota: true }));
  const b = writeBatch(t);                                                                                    // 1 bump, 2 links
  b.set(D(t, qpath(TEA)), quotaDoc(TEA, 1, `${STU}_${TEA}`));
  b.set(D(t, `links/${STU}_${TEA}`), useridInvite(STU, TEA));
  b.set(D(t, `links/${STU2}_${TEA}`), useridInvite(STU2, TEA));
  await assertFails(b.commit());
  await assertSucceeds(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));                        // control
  // quota bump naming a link that already exists (an old invite) must not count
  await assertFails(inviteBatch(t, TEA, `${STU2}_${TEA}`, useridInvite(STU2, TEA), { noLink: true, lastLinkId: `${STU}_${TEA}`, count: 2 }));
});
test("4-tamper client cannot decrement, reset, delete, jump by 2, or use another day / fake adultUid / extra key", async () => {
  await seedUsers();
  const t = as(TEA);
  for (let i = 1; i <= 3; i++) await assertSucceeds(inviteBatch(t, TEA, `s${i}_${TEA}`, useridInvite(`s${i}`, TEA)));
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { count: 2 }));   // decrement
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { count: 1 }));   // reset
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { count: 5 }));   // jump
  await assertFails(deleteDoc(D(t, qpath(TEA))));
  await assertFails(setDoc(D(t, qpath(TEA)), quotaDoc(TEA, 0, "none")));                          // direct reset
  await assertFails(updateDoc(D(t, qpath(TEA)), { count: 0 }));
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { quotaOver: { adultUid: PAR } }));
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { quotaOver: { extra: 1 } }));
  await assertFails(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA), { lastLinkId: "a/b" }));
  await assertSucceeds(inviteBatch(t, TEA, `s4_${TEA}`, useridInvite("s4", TEA)));                // control
});
test("4-day quota doc must be today's: another day's doc id or `day` field is rejected", async () => {
  await seedUsers();
  const t = as(TEA);
  const other = utcDayKey(new Date(Date.now() - 2 * 86400000));
  await assertFails(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA), { quotaId: `${TEA}_${other}`, day: other, count: 1 }));
  await assertFails(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA), { quotaOver: { day: other } }));
  await assertSucceeds(inviteBatch(t, TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
});
test("4-rollover a full quota doc from a previous day does not block today (new day = new doc id)", async () => {
  await seedUsers();
  const y = utcDayKey(new Date(Date.now() - 86400000));
  await seed((db) => setDoc(D(db, qpath(TEA, y)), quotaDoc(TEA, 30, "old", { day: y })));
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  const q = await seed((db) => getDoc(D(db, qpath(TEA))));
  assert.equal(q.data().count, 1);
  // The emulator cannot advance request.time, so the real midnight flip is covered only by this id-based argument.
});
test("4-who students and parents-of-others cannot write or read the wrong quota", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(STU), qpath(STU)), quotaDoc(STU, 1, `x_${STU}`)));
  await assertFails(inviteBatch(as(STU), STU, `${STU2}_${STU}`, useridInvite(STU2, STU)));
  await assertFails(inviteBatch(as(PAR), PAR, `${STU}_${TEA}`, useridInvite(STU, TEA), { quotaId: `${TEA}_${utcDayKey()}`, quotaOver: { adultUid: TEA } }));
  await assertSucceeds(inviteBatch(as(TEA), TEA, `${STU}_${TEA}`, useridInvite(STU, TEA)));
  await assertSucceeds(getDoc(D(as(TEA), qpath(TEA))));
  await assertFails(getDoc(D(as(PAR), qpath(TEA))));
  await assertFails(getDoc(D(anon(), qpath(TEA))));
  await assertSucceeds(getDoc(D(as(PAR), qpath(PAR))));   // own, missing doc is readable
});
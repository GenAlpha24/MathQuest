// Firestore rules tests. Run via the emulator (see README.md).
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

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
const seed = (fn) => env.withSecurityRulesDisabled(async (c) => fn(c.firestore()));
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
  await assertSucceeds(setDoc(D(as(TEA), `links/${STU}_${TEA}`), useridInvite(STU, TEA)));
  const s = as(STU);
  await assertSucceeds(updateDoc(D(s, `links/${STU}_${TEA}`), { status: "accepted", decidedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(D(s, `users/${STU}`), activate(STU, TEA)));
});

// ---------------- 4. email invite w/ mixed-case stored email ----------------
test("4 email invite -> canonical accepted link (c2) -> activate, mixed-case stored email", async () => {
  await seedUsers();
  const lc = MIXED.toLowerCase();
  await assertSucceeds(setDoc(D(as(PAR), `links/email|${PAR}|${lc}`), emailInvite(PAR, lc)));
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
  await assertFails(setDoc(D(as(PAR), `links/email|${PAR}|${MIXED}`), emailInvite(PAR, MIXED)));
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
test("7 adult linked to student reads student doc; self reads own", async () => {
  await seedUsers();
  await seedLink(`${STU}_${TEA}`, useridInvite(STU, TEA));
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
  await assertFails(setDoc(D(as(STU), `links/${STU2}_${STU}`), useridInvite(STU2, STU)));
  await assertFails(setDoc(D(as(STU), `links/${STU}_${STU2}`), useridInvite(STU, STU2)));
  await assertFails(setDoc(D(as(STU), `links/email|${STU}|a@b.com`), emailInvite(STU, "a@b.com")));
});
test("14b N5 adult creates invite naming a different adultUid", async () => {
  await seedUsers();
  await assertFails(setDoc(D(as(TEA), `links/${STU}_${PAR}`), useridInvite(STU, PAR)));
  await assertFails(setDoc(D(as(TEA), `links/email|${PAR}|a@b.com`), emailInvite(PAR, "a@b.com")));
  await assertFails(setDoc(D(as(TEA), `links/${STU}_${TEA}`), { ...useridInvite(STU, TEA), createdBy: PAR }));
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

"use strict";
// Callable e2e through the Auth + Firestore + Functions emulators (project demo-mathquest, no live calls).
//   Mock mode (default run):
//     $env:MQ_MOCK_MODEL='1'; firebase emulators:exec --only auth,firestore,functions --project demo-mathquest "node --test functions/test/e2e.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initializeApp: initAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore: adminDb } = require("firebase-admin/firestore");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require("firebase/firestore");

const MOCK_ON = process.env.MQ_MOCK_MODEL === "1";
const ROOT = path.join(__dirname, "..", "..");
const rulesHaveGames = /match\s+\/games\/\{/.test(fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8"));

assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, "run under the emulators");
initAdmin({ projectId: "demo-mathquest" });
const aAuth = adminAuth();
const aDb = adminDb();

const apps = [];
async function client(uid, name) {
  const app = initializeApp({ projectId: "demo-mathquest", apiKey: "fake-key", authDomain: "localhost" }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  if (uid) await signInWithCustomToken(auth, await aAuth.createCustomToken(uid));
  return { app, auth, firestore, generate: httpsCallable(functions, "generateGame") };
}
async function makeUser(uid, profile) {
  await aAuth.createUser({ uid });
  await aDb.collection("users").doc(uid).set({ name: "E2E " + uid, email: uid + "@example.test", grade: 1, role: "student", status: "active", ...profile });
}
const rejects = (p, code, detail) => assert.rejects(p, (e) => {
  assert.equal(e.code, "functions/" + code);
  if (detail) assert.equal(e.details && e.details.code, detail);
  return true;
});
const dayKey = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const tag = Date.now().toString(36);

test.after(async () => { await Promise.all(apps.map((a) => deleteApp(a).catch(() => {}))); });

test("index.js: mock guard is the two-part check and K_SERVICE is never referenced", () => {
  const src = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
  assert.ok(src.includes('process.env.FUNCTIONS_EMULATOR === "true" && process.env.MQ_MOCK_MODEL === "1"'));
  assert.ok(!src.includes("K_SERVICE"));
  assert.ok(!/MQ_MOCK_MODEL[^\n]*\|\|/.test(src));
});

if (!MOCK_ON) {
  // Never exercise the unset-flag path here: without the mock the handler would try the real Vertex client.
  test("e2e cases need MQ_MOCK_MODEL=1", { skip: true }, () => {});
} else {
  test("unauthenticated call is rejected", async () => {
    const c = await client(null, "anon");
    await rejects(c.generate({ prompt: "tell me about volcanoes" }), "unauthenticated");
  });

  test("pending student is rejected with pending", async () => {
    const uid = "pend" + tag;
    await makeUser(uid, { status: "pending" });
    const c = await client(uid, "pend");
    await rejects(c.generate({ prompt: "tell me about volcanoes" }), "permission-denied", "pending");
  });

  test("active student happy path: game saved; read access follows the deployed rules", async () => {
    const uid = "kid" + tag, other = "other" + tag;
    await makeUser(uid, {});
    await makeUser(other, {});
    const c = await client(uid, "kid");
    const o = await client(other, "other");
    const r = await c.generate({ prompt: "tell me about volcanoes", grade: 2 });
    assert.equal(r.data.status, "ok");
    assert.equal(r.data.remaining, 9);
    assert.equal(r.data.game.questionCount, 8);
    assert.equal(r.data.game.grade, 2);
    const stored = await aDb.collection("games").doc(r.data.gameId).get();
    assert.ok(stored.exists);
    assert.equal(stored.data().createdBy, uid);
    const ref = (cl) => doc(cl.firestore, "games", r.data.gameId);
    if (rulesHaveGames) {
      assert.equal((await getDoc(ref(c))).data().title, "Fun Number Quiz");
      await assert.rejects(getDoc(ref(o)), (e) => e.code === "permission-denied");
    } else {
      // Before the games rules land, the current rules deny every client read of games.
      await assert.rejects(getDoc(ref(c)), (e) => e.code === "permission-denied");
      await assert.rejects(getDoc(ref(o)), (e) => e.code === "permission-denied");
    }
  });

  test("client writes to games and usage are denied", async () => {
    const uid = "writer" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "writer");
    await assert.rejects(setDoc(doc(c.firestore, "games", "forged" + tag), { createdBy: uid, title: "forged" }), (e) => e.code === "permission-denied");
    await assert.rejects(setDoc(doc(c.firestore, "usage", uid + "_" + dayKey(new Date())), { requests: 0 }), (e) => e.code === "permission-denied");
    assert.ok(!(await aDb.collection("games").doc("forged" + tag).get()).exists);
  });

  test("off-topic request is refused with the fixed copy and stores no game", async () => {
    const uid = "off" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "off");
    const r = await c.generate({ prompt: "mockoffTopic please" });
    assert.equal(r.data.status, "refused");
    assert.equal(r.data.reason, "off_topic");
    assert.match(r.data.message, /science, technology, engineering, art and math/);
    assert.equal((await aDb.collection("games").where("createdBy", "==", uid).get()).size, 0);
  });

  test("pre-filter refusal comes back as refused without using quota", async () => {
    const uid = "pre" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "pre");
    const r = await c.generate({ prompt: "visit www.example.com now" });
    assert.equal(r.data.status, "refused");
    assert.equal(r.data.reason, "url");
    assert.ok(!(await aDb.collection("usage").doc(uid + "_" + dayKey(new Date())).get()).exists);
  });

  test("quota exhaustion -> resource-exhausted daily_quota", async () => {
    const uid = "quota" + tag;
    await makeUser(uid, {});
    await aDb.collection("usage").doc(uid + "_" + dayKey(new Date())).set({ uid, requests: 10 });
    const c = await client(uid, "quota");
    await rejects(c.generate({ prompt: "tell me about volcanoes" }), "resource-exhausted", "daily_quota");
  });

  test("invalid-once mock succeeds after the server retry; invalid-twice fails with unavailable", async () => {
    const uid = "inv" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "inv");
    const ok = await c.generate({ prompt: "mockinvalidonce volcanoes" });
    assert.equal(ok.data.status, "ok");
    await rejects(c.generate({ prompt: "mockinvalidtwice volcanoes" }), "unavailable", "gen_failed");
  });

  test("bad arguments -> invalid-argument", async () => {
    const uid = "arg" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "arg");
    await rejects(c.generate({ prompt: "tell me about volcanoes", count: 99 }), "invalid-argument", "count");
  });

  // ---- Phase 3: templates and pictures through the callable (mock model) ----
  const firstVisual = (g) => {
    const lists = [];
    (g.questions || []).forEach((q) => lists.push(q.visual));
    (g.pairs || []).forEach((p) => { lists.push(p.a.visual, p.b.visual); });
    (g.rounds || []).forEach((r) => r.steps.forEach((s) => lists.push(s.visual)));
    (g.items || []).forEach((i) => lists.push(i.visual));
    return lists.find((v) => v && v.kind) || null;
  };

  test("template 'auto' gives each template's game with its own payload shape; stored type matches", async () => {
    const uid = "tpl" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "tpl");
    const shapes = { mockmemory: ["memory", "pairs"], mocksequence: ["sequence", "rounds"], mocksort: ["sort", "items"], mockcatch: ["catch", "questions"], mockpicture: ["picturequiz", "questions"] };
    for (const [word, [type, key]] of Object.entries(shapes)) {
      const r = await c.generate({ prompt: word + " plants", grade: 2, template: "auto" });
      assert.equal(r.data.status, "ok", word);
      assert.equal(r.data.game.type, type, word);
      assert.equal(r.data.game.schemaVersion, 2);
      assert.ok(Array.isArray(r.data.game[key]) && r.data.game[key].length >= 3, word);
      assert.equal(r.data.templateNote, null);
      assert.equal((await aDb.collection("games").doc(r.data.gameId).get()).data().type, type);
    }
  });

  test("each of the 8 picture kinds comes back attached and stored", async () => {
    const uid = "vis" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "vis");
    const words = { mockbar: "barChart", mockpie: "pie", mockline: "numberLine", mockclock: "clock", mockshape: "shape", mockemoji: "emojiGroup", mockpicto: "pictograph", mockthermo: "thermometer" };
    for (const [word, kind] of Object.entries(words)) {
      const r = await c.generate({ prompt: word + " math", grade: 2, template: "quiz" });
      assert.equal(r.data.status, "ok", word);
      assert.equal(r.data.game.type, "quiz");
      const v = firstVisual(r.data.game);
      assert.ok(v && v.kind === kind, word + " -> " + (v && v.kind));
      const stored = (await aDb.collection("games").doc(r.data.gameId).get()).data();
      assert.equal(firstVisual(stored).kind, kind);
    }
  });

  test("user-chosen template is honored; a template that does not fit falls back with templateNote", async () => {
    const uid = "ovr" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "ovr");
    const chosen = await c.generate({ prompt: "volcanoes", grade: 2, template: "picturequiz" });
    assert.equal(chosen.data.game.type, "picturequiz");
    assert.equal(chosen.data.templateNote, null);
    const fb = await c.generate({ prompt: "mockfallback volcanoes", grade: 2, template: "memory" });
    assert.equal(fb.data.status, "ok");
    assert.equal(fb.data.templateNote, "fallback");
    assert.equal(fb.data.game.type, "quiz");
    const legacy = await c.generate({ prompt: "mockmemory volcanoes", grade: 2 });
    assert.equal(legacy.data.game.type, "quiz", "a client that sends no template always gets the classic quiz");
    await rejects(c.generate({ prompt: "volcanoes", template: "hologram" }), "invalid-argument", "template");
  });

  test("variety: after 3 identical games 'auto' picks another fitting template", async () => {
    const uid = "var" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "var");
    for (let i = 0; i < 3; i++) {
      const r = await c.generate({ prompt: "mockquiz clouds " + i, grade: 2, template: "auto" });
      assert.equal(r.data.game.type, "quiz");
    }
    const fourth = await c.generate({ prompt: "mockquiz clouds four", grade: 2, template: "auto" });
    assert.notEqual(fourth.data.game.type, "quiz");
    assert.equal(fourth.data.game.templateSource, "variety");
  });

  test("invalid-once retries and invalid-twice fails for a non-quiz template and for a picture game", async () => {
    const uid = "rty" + tag;
    await makeUser(uid, {});
    const c = await client(uid, "rty");
    const ok = await c.generate({ prompt: "mockinvalidonce mockmemory plants", grade: 2, template: "auto" });
    assert.equal(ok.data.game.type, "memory");
    const fixed = await c.generate({ prompt: "mockbadvisual mockpie pizza", grade: 2, template: "quiz" });
    assert.equal(fixed.data.status, "ok");
    assert.equal(firstVisual(fixed.data.game).kind, "pie");
    await rejects(c.generate({ prompt: "mockinvalidtwice mocksort things", grade: 2, template: "auto" }), "unavailable", "gen_failed");
  });
}

"use strict";
// Handler integration tests: real firebase-admin Firestore against the emulator, scripted model via deps.
// Run: firebase emulators:exec --only auth,firestore --project demo-mathquest "node --test functions/test/handler.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const cfg = require("../lib/config");
const quota = require("../lib/quota");
const { handleGenerate } = require("../lib/handler");
const { REFUSALS } = require("../lib/prompts");
const mock = require("../lib/mock-model");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run under the Firestore emulator");
initializeApp({ projectId: "demo-mathquest" });
const db = getFirestore();

const DAY = 86400000;
const BASE = Date.UTC(2035, 0, 1, 12);
// Every test uses its own UTC day so the shared usage/global_<day> doc never leaks between tests.
let dayCounter = 0;
const nextDay = () => BASE + (dayCounter++) * DAY;
const clockAt = (ms) => () => new Date(ms);
let uidCounter = 0;
const newUid = (p) => p + "_" + (uidCounter++) + "_" + Date.now();

const PROMPT = "tell me about volcanoes";
const res = (text) => ({ text, blocked: false, blockReason: null, finishReason: "STOP", inTokens: 5, outTokens: 5 });
const blockedRes = () => ({ text: "", blocked: true, blockReason: "SAFETY", finishReason: null, inTokens: 5, outTokens: 0 });
const clsText = (o) => JSON.stringify({ isSteam: true, safe: true, refusalReason: "none", subject: "Science", topic: "Volcanoes", theme: null, grade: 1, difficulty: "easy", ...o });
const gameText = (n = 8, extra = {}) => JSON.stringify({
  stayedOnSteamTopic: true, title: "Volcano Fun",
  questions: Array.from({ length: n }, (_, i) => ({
    text: "What is " + (i + 1) + " plus one?", options: ["2", "3", "4"], correctIndex: i % 3,
    hint: "Think about counting.", explanation: "Counting up gives the next number.", emoji: null, ...extra,
  })),
  ...extra,
});

function scripted(script) {
  const calls = { classify: [], generate: [] };
  const next = async (kind, req) => {
    calls[kind].push(req);
    const arr = script[kind] || [];
    let item = arr[Math.min(calls[kind].length - 1, arr.length - 1)];
    if (typeof item === "function") item = await item(req);
    if (item instanceof Error) throw item;
    return item;
  };
  return { classify: (r) => next("classify", r), generate: (r) => next("generate", r), calls };
}
const goodModel = () => scripted({ classify: [res(clsText())], generate: [res(gameText())] });

function makeLogger() {
  const lines = [];
  const push = (lvl) => (...a) => lines.push(lvl + " " + JSON.stringify(a));
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

async function seedUser(uid, over) {
  const doc = { name: "Zed Quillfeather", email: "zed.quillfeather@example.test", role: "student", status: "active", grade: 1, ...over };
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  await db.collection("users").doc(uid).set(doc);
}
const call = (uid, data, deps) => handleGenerate({ auth: uid ? { uid } : undefined, data }, deps);
const mk = (model, ms, logger) => ({ db, model, now: clockAt(ms), logger: logger || makeLogger() });
const rejectsWith = (p, code, detail) => assert.rejects(p, (e) => {
  assert.equal(e.code, code);
  if (detail) assert.equal(e.details && e.details.code, detail);
  return true;
});
const usageDoc = async (uid, ms) => (await db.collection("usage").doc(uid + "_" + quota.dayKey(ms)).get()).data();
const globalDoc = async (ms) => (await db.collection("usage").doc("global_" + quota.dayKey(ms)).get()).data();
const gamesOf = async (uid) => (await db.collection("games").where("createdBy", "==", uid).get()).docs;

test("happy path saves exactly one game with the 4.1 shape and bumps usage", async () => {
  const uid = newUid("s"), ms = nextDay();
  await seedUser(uid);
  const model = goodModel();
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(out.status, "ok");
  assert.equal(out.remaining, 9);
  assert.equal(model.calls.classify.length, 1);
  assert.equal(model.calls.generate.length, 1);
  const docs = await gamesOf(uid);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, out.gameId);
  const g = docs[0].data();
  assert.deepEqual(
    Object.keys(g).sort(),
    ["schemaVersion", "type", "status", "title", "subject", "topic", "grade", "difficulty", "prompt", "questions", "questionCount",
      "createdBy", "creatorRole", "createdAt", "expireAt", "model", "promptVersion"].sort(),
  );
  assert.equal(g.schemaVersion, 1);
  assert.equal(g.type, "quiz");
  assert.equal(g.status, "ok");
  assert.equal(g.prompt, PROMPT);
  assert.equal(g.questionCount, 8);
  assert.equal(g.questions.length, 8);
  assert.equal(g.questions[0].id, "q1");
  assert.equal(g.creatorRole, "student");
  assert.equal(g.model, cfg.MODEL_ID);
  assert.ok(g.createdAt instanceof Timestamp);
  assert.equal(g.expireAt.toMillis(), ms + 365 * DAY);
  assert.equal(out.game.createdBy, undefined);
  const u = await usageDoc(uid, ms);
  assert.equal(u.requests, 1);
  assert.equal(u.games, 1);
  assert.equal(u.lockUntil, null);
  assert.equal((await globalDoc(ms)).requests, 1);
});

test("classifier refusal returns fixed copy, stores no game, counts the attempt", async () => {
  const uid = newUid("s"), ms = nextDay();
  await seedUser(uid);
  const model = scripted({ classify: [res(clsText({ isSteam: false, refusalReason: "off_topic", topic: "none" }))] });
  const out = await call(uid, { prompt: "tell me about football" }, mk(model, ms));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "off_topic");
  assert.equal(out.message, REFUSALS.off_topic);
  assert.equal(model.calls.generate.length, 0);
  assert.equal((await gamesOf(uid)).length, 0);
  const u = await usageDoc(uid, ms);
  assert.equal(u.requests, 1);
  assert.equal(u.refusals, 1);
});

test("pre-filter refusal consumes nothing and never calls the model", async () => {
  const uid = newUid("s"), ms = nextDay();
  await seedUser(uid);
  const model = goodModel();
  const out = await call(uid, { prompt: "email me at kid@example.com" }, mk(model, ms));
  assert.equal(out.status, "refused");
  assert.equal(out.message, REFUSALS[out.reason]);
  assert.equal(model.calls.classify.length + model.calls.generate.length, 0);
  assert.equal(await usageDoc(uid, ms), undefined);
  assert.equal(await globalDoc(ms), undefined);
});

test("argument validation: bad prompt, grade, count", async () => {
  const uid = newUid("s"), ms = nextDay();
  await seedUser(uid);
  const model = goodModel();
  await rejectsWith(call(uid, { prompt: 42 }, mk(model, ms)), "invalid-argument", "prompt");
  await rejectsWith(call(uid, {}, mk(model, ms)), "invalid-argument", "prompt");
  await rejectsWith(call(uid, { prompt: "x".repeat(2001) }, mk(model, ms)), "invalid-argument", "prompt");
  await rejectsWith(call(uid, { prompt: PROMPT, grade: 9 }, mk(model, ms)), "invalid-argument", "grade");
  await rejectsWith(call(uid, { prompt: PROMPT, grade: 1.5 }, mk(model, ms)), "invalid-argument", "grade");
  await rejectsWith(call(uid, { prompt: PROMPT, count: 3 }, mk(model, ms)), "invalid-argument", "count");
  await rejectsWith(call(uid, { prompt: PROMPT, count: 16 }, mk(model, ms)), "invalid-argument", "count");
  assert.equal(model.calls.classify.length, 0);
  assert.equal(await usageDoc(uid, ms), undefined);
});

test("unauthenticated call is rejected before anything else", async () => {
  const model = goodModel();
  await rejectsWith(call(null, { prompt: PROMPT }, mk(model, nextDay())), "unauthenticated");
  assert.equal(model.calls.classify.length, 0);
});

test("pending student -> permission-denied pending; role-less and missing docs -> profile; no quota consumed", async () => {
  const ms = nextDay();
  const pend = newUid("p"), noRole = newUid("r"), missing = newUid("m");
  await seedUser(pend, { status: "pending" });
  await seedUser(noRole, { role: undefined });
  const model = goodModel();
  await rejectsWith(call(pend, { prompt: PROMPT }, mk(model, ms)), "permission-denied", "pending");
  await rejectsWith(call(noRole, { prompt: PROMPT }, mk(model, ms)), "permission-denied", "profile");
  await rejectsWith(call(missing, { prompt: PROMPT }, mk(model, ms)), "permission-denied", "profile");
  assert.equal(model.calls.classify.length, 0);
  assert.equal(await usageDoc(pend, ms), undefined);
  assert.equal(await globalDoc(ms), undefined);
});

test("teacher and parent are allowed", async () => {
  const ms = nextDay();
  for (const role of ["teacher", "parent"]) {
    const uid = newUid(role);
    await seedUser(uid, { role, status: "active" });
    const out = await call(uid, { prompt: PROMPT }, mk(goodModel(), ms));
    assert.equal(out.status, "ok");
    assert.equal((await gamesOf(uid))[0].data().creatorRole, role);
    assert.equal(out.remaining, 24);
  }
});

test("student limit 10 -> 11th attempt is daily_quota; adult limit is 25", async () => {
  const ms = nextDay();
  const s = newUid("s");
  await seedUser(s);
  const m = mock.create();
  for (let i = 0; i < 10; i++) assert.equal((await call(s, { prompt: PROMPT }, mk(m, ms))).status, "ok");
  await rejectsWith(call(s, { prompt: PROMPT }, mk(m, ms)), "resource-exhausted", "daily_quota");
  assert.equal((await gamesOf(s)).length, 10);

  const a = newUid("t");
  await seedUser(a, { role: "teacher" });
  await db.collection("usage").doc(a + "_" + quota.dayKey(ms)).set({ uid: a, day: quota.dayKey(ms), requests: 24 });
  assert.equal((await call(a, { prompt: PROMPT }, mk(m, ms))).status, "ok");
  await rejectsWith(call(a, { prompt: PROMPT }, mk(m, ms)), "resource-exhausted", "daily_quota");
});

test("global cap -> global_cap", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  await db.collection("usage").doc("global_" + quota.dayKey(ms)).set({ day: quota.dayKey(ms), requests: cfg.GLOBAL_DAILY_CAP });
  const model = goodModel();
  await rejectsWith(call(uid, { prompt: PROMPT }, mk(model, ms)), "resource-exhausted", "global_cap");
  assert.equal(model.calls.classify.length, 0);
});

test("concurrent double call: second gets busy, only one model run", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  // The winner's classify call waits on a gate, so the loser must be rejected while the lock is held.
  let release;
  const gate = new Promise((r) => { release = r; });
  const model = scripted({
    classify: [async () => { await gate; return res(clsText()); }],
    generate: [res(gameText())],
  });
  const both = [call(uid, { prompt: PROMPT }, mk(model, ms)), call(uid, { prompt: PROMPT }, mk(model, ms))]
    .map((p) => p.then((v) => ({ v }), (e) => ({ e })));
  const first = await Promise.race(both);
  assert.ok(first.e, "the loser settles first");
  assert.equal(first.e.code, "resource-exhausted");
  assert.equal(first.e.details.code, "busy");
  release();
  const results = await Promise.all(both);
  assert.equal(results.filter((r) => r.v).length, 1);
  assert.equal(results.filter((r) => r.e).length, 1);
  assert.equal(model.calls.classify.length, 1);
  assert.equal((await gamesOf(uid)).length, 1);
  assert.equal((await usageDoc(uid, ms)).requests, 1);
});

test("lock: future lockUntil -> busy; expired lockUntil -> allowed", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const ref = db.collection("usage").doc(uid + "_" + quota.dayKey(ms));
  await ref.set({ uid, requests: 0, lockUntil: Timestamp.fromMillis(ms + 60000) });
  await rejectsWith(call(uid, { prompt: PROMPT }, mk(goodModel(), ms)), "resource-exhausted", "busy");
  await ref.set({ uid, requests: 0, lockUntil: Timestamp.fromMillis(ms - 1000) });
  assert.equal((await call(uid, { prompt: PROMPT }, mk(goodModel(), ms))).status, "ok");
});

test("invalid generation then valid: saved after exactly 2 generate calls, retry carries fix codes only", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const bad = JSON.stringify({ stayedOnSteamTopic: true, title: "SECRETMODELTEXT", questions: [] });
  const model = scripted({ classify: [res(clsText())], generate: [res(bad), res(gameText())] });
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(out.status, "ok");
  assert.equal(model.calls.generate.length, 2);
  const second = JSON.parse(model.calls.generate[1].userText);
  assert.deepEqual(second.fixes, ["questions_count"]);
  assert.ok(!model.calls.generate[1].userText.includes("SECRETMODELTEXT"));
  assert.equal((await gamesOf(uid)).length, 1);
});

test("invalid twice -> unavailable model, refund applied, no game; refund cap 3 per day, global never refunded", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [res(clsText())], generate: [res("not json")] });
  for (let i = 1; i <= 4; i++) {
    await rejectsWith(call(uid, { prompt: PROMPT }, mk(model, ms)), "unavailable", "model");
    const u = await usageDoc(uid, ms);
    assert.equal(u.requests, i <= 3 ? 0 : 1, "after failure " + i);
    assert.equal(u.refunds, Math.min(i, 3));
    assert.equal(u.failures, i);
    assert.equal(u.lockUntil, null);
  }
  assert.equal(model.calls.generate.length, 8);
  assert.equal((await gamesOf(uid)).length, 0);
  assert.equal((await globalDoc(ms)).requests, 4);
});

test("classifier invalid then valid: ok with 2 classify calls", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [res("nope"), res(clsText())], generate: [res(gameText())] });
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(out.status, "ok");
  assert.equal(model.calls.classify.length, 2);
});

test("classifier invalid twice -> unavailable model with refund", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [res("nope")] });
  await rejectsWith(call(uid, { prompt: PROMPT }, mk(model, ms)), "unavailable", "model");
  assert.equal(model.calls.classify.length, 2);
  assert.equal((await usageDoc(uid, ms)).requests, 0);
});

test("safety block in classify -> refused unsafe, no retry, no refund", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [blockedRes()] });
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "unsafe");
  assert.equal(out.message, REFUSALS.unsafe);
  assert.equal(model.calls.classify.length, 1);
  const u = await usageDoc(uid, ms);
  assert.equal(u.requests, 1);
  assert.equal(u.refunds, 0);
  assert.equal(u.refusals, 1);
});

test("two safety blocks in generate -> refused unsafe, 2 generate calls, no game", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [res(clsText())], generate: [blockedRes()] });
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(out.status, "refused");
  assert.equal(out.reason, "unsafe");
  assert.equal(model.calls.generate.length, 2);
  assert.equal((await gamesOf(uid)).length, 0);
  assert.equal((await usageDoc(uid, ms)).refunds, 0);
});

test("model throws 503 -> retried once, then unavailable model with refund", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const err = Object.assign(new Error("upstream said: tell me about volcanoes"), { status: 503 });
  const logger = makeLogger();
  const model = scripted({ classify: [err] });
  await rejectsWith(call(uid, { prompt: PROMPT }, mk(model, ms, logger)), "unavailable", "model");
  assert.equal(model.calls.classify.length, 2);
  assert.equal((await usageDoc(uid, ms)).requests, 0);
  const logs = logger.lines.join("\n");
  assert.ok(logs.includes("503"));
  assert.ok(!logs.includes("upstream said"), "SDK error messages are never logged");
});

test("finish is atomic: a failing save leaves no game and an unchanged games counter", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const ctx = await quota.reserve(db, uid, new Date(ms));
  await assert.rejects(quota.finish(db, ctx, new Date(ms), { game: { createdBy: uid, bad: undefined } }));
  assert.equal((await gamesOf(uid)).length, 0);
  const u = await usageDoc(uid, ms);
  assert.equal(u.games, 0);
  assert.ok(u.lockUntil, "lock still held until the transaction that succeeds or expiry");
  await quota.finish(db, ctx, new Date(ms), { outcome: "failure", refund: true });
  assert.equal((await usageDoc(uid, ms)).lockUntil, null);
});

test("handler maps a save failure to unavailable store with refund and no game", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  let n = 0;
  const flaky = {
    reserve: quota.reserve,
    finish: async (d, c, now, result) => {
      if (result.game) throw new Error("boom");
      n++;
      return quota.finish(d, c, now, result);
    },
  };
  const deps = { ...mk(goodModel(), ms), quota: flaky };
  await rejectsWith(call(uid, { prompt: PROMPT }, deps), "unavailable", "store");
  assert.equal(n, 1);
  assert.equal((await gamesOf(uid)).length, 0);
  assert.equal((await usageDoc(uid, ms)).requests, 0);
});

test("model never receives uid, email or name; generate never sees the raw prompt", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid, { name: "Zed Quillfeather", email: "zed.quillfeather@example.test", userid: "zedq77" });
  const model = scripted({ classify: [res(clsText())], generate: [res(gameText())] });
  await call(uid, { prompt: "xylophone volcanoes please" }, mk(model, ms));
  const all = JSON.stringify([...model.calls.classify, ...model.calls.generate]);
  for (const secret of [uid, "quillfeather", "Zed", "example.test", "zedq77"]) assert.ok(!all.includes(secret), "leaked " + secret);
  assert.ok(JSON.stringify(model.calls.classify).includes("xylophone"));
  assert.ok(!JSON.stringify(model.calls.generate).includes("xylophone"));
});

test("logs never contain the prompt or model text", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const logger = makeLogger();
  const model = scripted({ classify: [res(clsText({ topic: "Zebrafish" }))], generate: [res("garbage SECRETMODELTEXT"), res(gameText())] });
  await call(uid, { prompt: "xylophone zebrafish stripes" }, mk(model, ms, logger));
  await call(uid, { prompt: "tell me about my password is hunter2" }, mk(model, ms, logger));
  assert.ok(logger.lines.length > 0);
  const logs = logger.lines.join("\n").toLowerCase();
  for (const s of ["xylophone", "zebrafish", "secretmodeltext", "volcano fun", "hunter2"]) assert.ok(!logs.includes(s), "logged " + s);
});

test("stored output is the normalized value; subject, topic and grade come from the classifier", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({
    classify: [res(clsText({ subject: "Technology", topic: "Robots", grade: 2, difficulty: "medium" }))],
    generate: [res(gameText(8, { subject: "Math", grade: 5, difficulty: "hard", extra: "x" }))],
  });
  const out = await call(uid, { prompt: PROMPT }, mk(model, ms));
  const g = (await gamesOf(uid))[0].data();
  assert.equal(g.subject, "Technology");
  assert.equal(g.topic, "Robots");
  assert.equal(g.grade, 2);
  assert.equal(g.difficulty, "medium");
  assert.equal(g.extra, undefined);
  assert.equal(g.questions[0].extra, undefined);
  assert.equal(out.game.subject, "Technology");
});

test("grade selector anchors the grade: named grade within 2 wins, farther is replaced", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid, { grade: 1 });
  let model = scripted({ classify: [res(clsText({ grade: 3 }))], generate: [res(gameText())] });
  await call(uid, { prompt: PROMPT }, mk(model, ms));
  assert.equal(JSON.parse(model.calls.generate[0].userText).grade, 3);
  const ms2 = nextDay();
  const uid2 = newUid("s");
  await seedUser(uid2, { grade: 1 });
  model = scripted({ classify: [res(clsText({ grade: 0 }))], generate: [res(gameText())] });
  await call(uid2, { prompt: PROMPT, grade: 4 }, mk(model, ms2));
  assert.equal(JSON.parse(model.calls.classify[0].userText).gradeHint, 4);
  assert.equal(JSON.parse(model.calls.generate[0].userText).grade, 4);
});

test("count argument reaches the generator", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const model = scripted({ classify: [res(clsText())], generate: [res(gameText(6))] });
  const out = await call(uid, { prompt: PROMPT, count: 6 }, mk(model, ms));
  assert.equal(JSON.parse(model.calls.generate[0].userText).questionCount, 6);
  assert.equal(out.game.questionCount, 6);
});

test("day rollover with injected now(): the next UTC day has a fresh quota", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  await db.collection("usage").doc(uid + "_" + quota.dayKey(ms)).set({ uid, requests: cfg.limits.STUDENT_DAILY });
  await rejectsWith(call(uid, { prompt: PROMPT }, mk(goodModel(), ms)), "resource-exhausted", "daily_quota");
  const tomorrow = ms + DAY;
  const out = await call(uid, { prompt: PROMPT }, mk(goodModel(), tomorrow));
  assert.equal(out.status, "ok");
  assert.equal((await usageDoc(uid, tomorrow)).requests, 1);
  assert.equal((await usageDoc(uid, ms)).requests, cfg.limits.STUDENT_DAILY);
  assert.notEqual(quota.dayKey(ms), quota.dayKey(tomorrow));
});

test("mock model is steered by trigger words", async () => {
  const ms = nextDay();
  const uid = newUid("s");
  await seedUser(uid);
  const m = mock.create();
  assert.equal((await call(uid, { prompt: "mockoffTopic please" }, mk(m, ms))).reason, "off_topic");
  assert.equal((await call(uid, { prompt: "mockblocked volcano" }, mk(m, ms))).reason, "unsafe");
  assert.equal((await call(uid, { prompt: "mockinvalidonce volcano" }, mk(m, ms))).status, "ok");
  await rejectsWith(call(uid, { prompt: "mockinvalidtwice volcano" }, mk(m, ms)), "unavailable", "model");
});

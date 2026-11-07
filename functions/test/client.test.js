"use strict";
// Client harness: loads the REAL index.html + questions.js into jsdom and drives the Create a Game /
// My games UI against the Functions + Firestore + Auth emulators (project demo-mathquest, mock model).
//   $env:MQ_MOCK_MODEL='1'; firebase emulators:exec --only auth,firestore,functions --project demo-mathquest "node --test functions/test/client.test.js"
// jsdom does not run <script type="module">, so the Firebase module block is replaced by a
// window.MathQuestCloud bridge defined here. The bridge forwards generateGame/listMyGames to the emulators
// with a Node Web SDK client (same protocol and queries as the module block, whose ~30 glue lines stay traced).
// The only change to the page source is a test hook appended inside the main script right after the
// MQ-CUSTOM:END marker (read-only getters + a few functions), so the rest of the game code is untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { initializeApp: initAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore: adminDb } = require("firebase-admin/firestore");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getFirestore, connectFirestoreEmulator, collection, getDocs, query, where, orderBy, limit } = require("firebase/firestore");

const ROOT = path.join(__dirname, "..", "..");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const QUESTIONS = fs.readFileSync(path.join(ROOT, "questions.js"), "utf8");
const MOCK_ON = process.env.MQ_MOCK_MODEL === "1";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, "run under the emulators");

initAdmin({ projectId: "demo-mathquest" });
const aAuth = adminAuth();
const aDb = adminDb();
const tag = "c" + Date.now().toString(36);
const apps = [];
const wins = [];
const DEL = Symbol("delete");

const HOOK = `
  window.__mq = {
    get state() { return state; }, get level() { return level; }, get best() { return bestScore; },
    get mega() { return megaGemsCollected; }, get ultra() { return ultraGemsCollected; },
    get lives() { return lives; }, set lives(v) { lives = v; }, get score() { return score; },
    get customRun() { return customRun; }, get currentQuestion() { return currentQuestion; },
    get monsters() { return monsters; }, adaptGame, startBattle,
  };`;

async function webClient(uid) {
  const app = initializeApp({ projectId: "demo-mathquest", apiKey: "fake-key", authDomain: "localhost" }, "cl-" + uid + "-" + Math.random().toString(36).slice(2));
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  await signInWithCustomToken(auth, await aAuth.createCustomToken(uid));
  return { auth, functions, firestore };
}

async function makeUser(uid, profile) {
  await aAuth.createUser({ uid });
  const doc = { name: "cl" + uid, email: uid + "@example.test", grade: 1, level: 1, best: 0, role: "student", status: "active", ...profile };
  for (const k of Object.keys(doc)) if (doc[k] === DEL) delete doc[k];
  await aDb.collection("users").doc(uid).set(doc);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

// ---- jsdom page + bridge ----
async function boot(uid, extra, opts = {}) {
  await makeUser(uid, extra || {});
  const web = await webClient(uid);
  const env = { uid, saves: [], genCalls: 0, opens: [], lastResult: null, statusCb: null, authCb: null, timers: [] };
  const available = opts.available !== false;
  const forward = async ({ prompt, grade }) => {
    try {
      const d = (await httpsCallable(web.functions, "generateGame", { timeout: 100000 })({ prompt, grade })).data || {};
      if (d.status === "ok" && d.game) return { ok: true, game: { ...d.game, id: d.gameId }, remaining: d.remaining };
      if (d.status === "refused") return { ok: false, kind: "refused", reason: d.reason, message: String(d.message || "") };
      return { ok: false, kind: "error", code: "unavailable" };
    } catch (e) {
      const code = String((e && e.details && e.details.code) || (e && e.code) || "").replace("functions/", "");
      return { ok: false, kind: "error", code };
    }
  };
  const base = {
    available,
    onAuthChange(cb) { env.authCb = cb; },
    async loadProfile(u) { const s = await aDb.collection("users").doc(u).get(); return s.exists ? s.data() : null; },
    async saveProfile(u, p) { env.saves.push(JSON.parse(JSON.stringify(p))); return { ok: true }; },
    setLeaderboardEligible() {},
    myLinkCode() { return "ABC2345"; },
    async backfillRole() { return true; },
    watchMyStatus(u, cb) { env.statusCb = cb; return () => {}; },
    async logout() { env.loggedOut = true; },
    async generateGame(a) {
      env.genCalls++;
      const r = opts.gen ? await opts.gen(a) : await forward(a);
      env.lastResult = r;
      return r;
    },
    async listMyGames() {
      const rows = [];
      const snap = await getDocs(query(collection(web.firestore, "games"), where("createdBy", "==", uid), orderBy("createdAt", "desc"), limit(30)));
      snap.forEach((d) => rows.push({ ...d.data(), id: d.id }));
      return rows;
    },
  };
  const cloud = new Proxy(base, { get: (t, p) => (p in t ? t[p] : async () => []) });
  const dom = new JSDOM(INDEX.replace('<script src="questions.js"></script>', () => "<script>" + QUESTIONS + "</script>")
    .replace("/* MQ-CUSTOM:END */", () => "/* MQ-CUSTOM:END */\n" + HOOK), {
    runScripts: "dangerously",
    url: "http://localhost/",
    beforeParse(win) {
      const noop = new Proxy(function () {}, { get: (t, p) => (p === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop, set: () => true });
      win.HTMLCanvasElement.prototype.getContext = () => noop;
      win.requestAnimationFrame = () => 0;
      win.AudioContext = undefined; win.webkitAudioContext = undefined;
      let n = 0;
      win.setTimeout = (fn) => { env.timers.push({ id: ++n, fn }); return n; };
      win.clearTimeout = (id) => { env.timers = env.timers.filter((t) => t.id !== id); };
      win.setInterval = () => ++n; win.clearInterval = () => {};
      win.open = (...a) => { env.opens.push(a); return null; };
      win.MathQuestCloud = cloud;
    },
  });
  wins.push(dom.window);
  env.win = dom.window;
  env.doc = dom.window.document;
  env.$ = (id) => env.doc.getElementById(id);
  env.mq = dom.window.__mq;
  env.flush = () => { let g = 0; while (env.timers.length && g++ < 500) env.timers.shift().fn(); };
  env.enter = async () => {
    await waitFor(() => env.authCb, "auth listener");
    env.authCb({ uid, name: "cl" + uid, email: uid + "@example.test" });
    await waitFor(() => env.$("topbar").style.display === "flex", "enterGame");
    await sleep(30); // let the backfill promise settle
  };
  env.shown = () => [...env.doc.querySelectorAll(".overlay.show")].map((o) => o.id);
  env.menuVisible = () => ["createGameBtn", "myGamesBtn"].map((id) => env.$(id).style.display !== "none");
  env.build = async (prompt) => {
    env.$("createGameBtn").click();
    env.$("cgPrompt").value = prompt;
    env.$("cgCreateBtn").click();
    await waitFor(() => !env.$("cgPreview").hidden || (env.$("cgMsg").textContent && env.$("cgMsg").textContent !== "Building your game... this can take up to a minute"), "build result");
  };
  const buttons = () => [...env.doc.querySelectorAll("#answers button")];
  env.answer = (text) => { buttons().find((b) => b.textContent === String(text)).click(); };
  env.answerRight = () => env.answer(env.mq.currentQuestion.answer);
  env.answerWrong = () => buttons().find((b) => b.textContent !== String(env.mq.currentQuestion.answer)).click();
  env.fight = () => { env.mq.startBattle(env.mq.monsters.find((m) => m.alive)); };
  env.clearLevel = () => {
    for (let g = 0; env.mq.state !== "levelClear" && g < 30; g++) { env.fight(); env.answerRight(); env.flush(); }
    assert.equal(env.mq.state, "levelClear");
  };
  env.loseGame = () => {
    for (let g = 0; env.mq.state !== "gameOver" && g < 60; g++) {
      if (env.mq.state === "playing") env.fight();
      env.answerWrong(); env.flush();
    }
    assert.equal(env.mq.state, "gameOver");
  };
  return env;
}

// A stored game doc written by the test (admin) so malformed / hostile content can be exercised.
const goodQ = (i, extra) => ({ id: "q" + (i + 1), text: "Question number " + (i + 1) + " here", options: ["alpha" + i, "beta" + i, "gamma" + i], correctIndex: i % 3, hint: "Hint " + i, explanation: "Because " + i, emoji: null, ...extra });
async function seedGame(uid, id, over) {
  await aDb.collection("games").doc(id).set({
    schemaVersion: 1, type: "quiz", status: "ok", title: "Seeded " + id, subject: "Science", topic: "seeded topic", grade: 1, difficulty: "easy",
    prompt: "seed", questions: [0, 1, 2, 3, 4].map((i) => goodQ(i)), questionCount: 5, createdBy: uid, creatorRole: "student",
    createdAt: new Date(), expireAt: new Date(Date.now() + 86400000), model: "seed", promptVersion: 1, ...over,
  });
}

test.after(async () => {
  for (const w of wins) { try { w.close(); } catch (e) { /* ignore */ } }
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

if (!MOCK_ON) {
  test("client cases need MQ_MOCK_MODEL=1 (callable path uses the mock model)", { skip: true }, () => {});
} else {
  test("page loads in jsdom and the hook is present; offline bridge leaves the new menu hidden", async () => {
    const env = await boot("off" + tag, {}, { available: false });
    assert.equal(typeof env.mq.adaptGame, "function");
    assert.deepEqual(env.menuVisible(), [false, false]);
    assert.match(env.$("authMsg").textContent, /Offline/);
  });

  test("source: hideAllOverlays lists both new overlays and game text never goes through innerHTML", () => {
    assert.match(INDEX, /function hideAllOverlays\(\)[\s\S]*?el\.createGame, el\.myGames\]/);
    const region = INDEX.slice(INDEX.indexOf("/* MQ-CUSTOM:BEGIN */"), INDEX.indexOf("async function renderGameList"));
    const bad = (region.match(/innerHTML\s*\+?=(?!\s*"";)/g) || []);
    assert.deepEqual(bad, []);
    assert.ok(!/outerHTML|insertAdjacentHTML/.test(region));
  });

  test("menu visibility per role and status; pending becomes active; logout hides", async () => {
    const stu = await boot("stu" + tag);
    await stu.enter();
    assert.deepEqual(stu.menuVisible(), [true, true]);
    stu.$("logoutBtn").click();
    await waitFor(() => stu.$("auth").classList.contains("show"), "auth screen");
    assert.deepEqual(stu.menuVisible(), [false, false]);

    const pend = await boot("pend" + tag, { status: "pending" });
    await pend.enter();
    assert.deepEqual(pend.menuVisible(), [false, false]);
    pend.statusCb({ status: "active" });
    assert.deepEqual(pend.menuVisible(), [true, true]);

    for (const role of ["teacher", "parent"]) {
      const a = await boot(role + tag, { role, status: "active", linkCode: "ABC2345" });
      await a.enter();
      assert.deepEqual(a.menuVisible(), [true, true], role);
    }
    const legacy = await boot("leg" + tag, { role: DEL, status: DEL });
    await legacy.enter();
    assert.deepEqual(legacy.menuVisible(), [true, true], "legacy role-less doc after backfill resolves true");
  });

  test("overlays: opening any new screen leaves exactly one overlay; other screens hide the new ones", async () => {
    const env = await boot("ov" + tag);
    await env.enter();
    env.$("createGameBtn").click();
    assert.deepEqual(env.shown(), ["createGame"]);
    env.$("cgMyGamesBtn").click();
    assert.deepEqual(env.shown(), ["myGames"]);
    env.$("createGameBtn").click();
    env.$("invitesBtn").click();
    assert.deepEqual(env.shown(), ["studentInvites"]);
    env.$("myGamesBtn").click();
    assert.deepEqual(env.shown(), ["myGames"]);
    env.$("myGamesCloseBtn").click();
    assert.deepEqual(env.shown(), ["start"]);
    const t = await boot("ovt" + tag, { role: "teacher", status: "active", linkCode: "ABC2345" });
    await t.enter();
    t.$("createGameBtn").click();
    t.$("studentsBtn").click();
    assert.deepEqual(t.shown(), ["approvalDesk"]);
  });

  test("Space typed in the prompt box is not swallowed (the page still jumps on Space elsewhere)", async () => {
    const env = await boot("sp" + tag);
    await env.enter();
    env.$("createGameBtn").click();
    const ev = () => new env.win.KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true });
    const inBox = ev(); env.$("cgPrompt").dispatchEvent(inBox);
    assert.equal(inBox.defaultPrevented, false);
    const elsewhere = ev(); env.doc.body.dispatchEvent(elsewhere);
    assert.equal(elsewhere.defaultPrevented, true);
  });

  test("empty prompt is rejected locally; double click makes exactly one callable invocation", async () => {
    const env = await boot("dbl" + tag);
    await env.enter();
    env.$("createGameBtn").click();
    env.$("cgCreateBtn").click();
    assert.equal(env.$("cgMsg").textContent, "Tell me your idea first!");
    assert.equal(env.genCalls, 0);
    env.$("cgPrompt").value = "how bridges stay up";
    env.$("cgCreateBtn").click();
    env.$("cgCreateBtn").click();
    assert.equal(env.$("cgCreateBtn").disabled, true);
    assert.equal(env.$("cgPrompt").disabled, true);
    await waitFor(() => !env.$("cgPreview").hidden, "preview");
    assert.equal(env.genCalls, 1);
    assert.equal(env.$("cgCreateBtn").disabled, false);
  });

  test("refusal and error copy (server message verbatim; fixed client table; raw errors never shown)", async () => {
    const off = await boot("rf" + tag);
    await off.enter();
    await off.build("mockoffTopic please");
    assert.match(off.$("cgMsg").textContent, /science, technology, engineering, art and math/);
    assert.equal(off.$("cgPrompt").value, "mockoffTopic please", "text kept for editing");
    assert.equal(off.$("cgPreview").hidden, true);

    const pend = await boot("pc" + tag, { status: "pending" });
    await pend.enter();
    await pend.build("tell me about volcanoes");
    assert.equal(pend.$("cgMsg").textContent, "Ask a parent or teacher to link with you first, then you can make games.");

    const table = {
      daily_quota: "You've made lots of games today! Come back tomorrow for more.",
      global_cap: "The game workshop is very busy today. Please try again tomorrow.",
      busy: "Hang on, I'm still building your last game.",
      unauthenticated: "Please log in again.",
      profile: "Please log out and log back in, then try again.",
      "invalid-argument": "Hmm, that didn't work. Check your idea and try again.",
      unavailable: "The game workshop is closed for a moment. Try again soon. Your regular game still works!",
      internal: "The game workshop is closed for a moment. Try again soon. Your regular game still works!",
      "weird-code": "The game workshop is closed for a moment. Try again soon. Your regular game still works!",
    };
    for (const [code, copy] of Object.entries(table)) {
      const e = await boot("er" + code.replace(/\W/g, "") + tag, {}, { gen: async () => ({ ok: false, kind: "error", code }) });
      await e.enter();
      await e.build("volcanoes and rocks");
      assert.equal(e.$("cgMsg").textContent, copy, code);
    }
    const offline = await boot("offk" + tag, {}, { gen: async () => ({ ok: false, kind: "offline" }) });
    await offline.enter();
    await offline.build("volcanoes and rocks");
    assert.match(offline.$("cgMsg").textContent, /workshop is closed/);
    const thrower = await boot("thr" + tag, {}, { gen: async () => { throw new Error("SECRET internal boom"); } });
    await thrower.enter();
    await thrower.build("volcanoes and rocks");
    assert.match(thrower.$("cgMsg").textContent, /workshop is closed/);
    assert.ok(!thrower.$("cgMsg").textContent.includes("SECRET"));
    assert.equal(thrower.$("cgCreateBtn").disabled, false, "form usable again after a failure");
  });

  test("preview -> Play: question, options and answer match the stored game; options are shuffled copies; hint, video word, explanation", async () => {
    const env = await boot("fid" + tag, { level: 4, best: 5 });
    await env.enter();
    await env.build("tell me about volcanoes");
    assert.equal(env.$("cgPreviewTitle").textContent, "Fun Number Quiz");
    assert.match(env.$("cgPreviewMeta").textContent, /Science · .* · 8 questions/);
    const gameId = env.lastResult.game.id;
    const stored = (await aDb.collection("games").doc(gameId).get()).data();
    const before = JSON.stringify(stored.questions);
    env.$("cgPlayBtn").click();
    assert.equal(env.mq.state, "playing");
    assert.deepEqual(env.shown(), []);
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      env.fight();
      const q = env.mq.currentQuestion;
      const s = stored.questions.find((x) => x.text === q.text);
      assert.ok(s, "served question exists in the stored game: " + q.text);
      assert.deepEqual([...q.opts].sort(), [...s.options].sort());
      assert.equal(q.answer, s.options[s.correctIndex]);
      assert.equal(env.doc.getElementById("question").textContent, s.text);
      assert.deepEqual([...env.doc.querySelectorAll("#answers button")].map((b) => b.textContent).sort(), [...s.options].sort());
      seen.add(q.text);
    }
    assert.ok(seen.size >= 5, "deck rotates through the questions");
    // hint + video word + explanation on one question
    env.fight();
    const q = env.mq.currentQuestion;
    const s = stored.questions.find((x) => x.text === q.text);
    env.$("mathHelpBtn").click();
    assert.equal(env.$("hint").textContent, s.hint);
    env.$("videoBtn").click();
    assert.equal(env.opens.length, 1);
    assert.ok(env.opens[0][0].endsWith("search_query=" + encodeURIComponent("how to do " + stored.topic + " for kids")), env.opens[0][0]);
    env.answerRight();
    assert.ok(env.$("feedback").textContent.includes(s.explanation), env.$("feedback").textContent);
    env.flush();
    assert.equal(JSON.stringify((await aDb.collection("games").doc(gameId).get()).data().questions), before, "stored doc untouched");
  });

  test("adaptGame: shuffled copies never mutate the input; malformed questions skipped; < 3 valid gives null", async () => {
    const env = await boot("ad" + tag);
    const { adaptGame } = env.mq;
    const def = { title: "T", topic: "t", subject: "Math", questions: [0, 1, 2].map((i) => goodQ(i, { options: ["a", "b", "c", "d"], correctIndex: 2 })) };
    const snapshot = JSON.stringify(def);
    const orders = new Set();
    for (let i = 0; i < 40; i++) {
      const g = adaptGame(def);
      assert.equal(g.questions[0].answer, "c");
      assert.deepEqual([...g.questions[0].opts].sort(), ["a", "b", "c", "d"]);
      orders.add(g.questions[0].opts.join(""));
    }
    assert.ok(orders.size > 1, "options are shuffled per adapt");
    assert.equal(JSON.stringify(def), snapshot);
    const bad = [
      null, 5, { text: 5 }, goodQ(0, { options: ["x"] }), goodQ(0, { options: ["x", "x"] }), goodQ(0, { options: ["x", " X "] }),
      goodQ(0, { correctIndex: 3 }), goodQ(0, { correctIndex: 1.5 }), goodQ(0, { correctIndex: "1" }), goodQ(0, { options: ["a", "", "c"] }),
      goodQ(0, { options: ["a", "b", 7] }), goodQ(0, { text: "" }), goodQ(0, { text: "x".repeat(301) }), goodQ(0, { options: ["a", "b", "c".repeat(81)] }),
      goodQ(0, { options: [1, 2, 3, 4, 5, 6, 7].map(String) }),
    ];
    const withBad = adaptGame({ title: "T", topic: "t", questions: [...bad, goodQ(5), goodQ(6), goodQ(7)] });
    assert.equal(withBad.questions.length, 3);
    assert.equal(adaptGame({ title: "T", topic: "t", questions: [...bad, goodQ(5), goodQ(6)] }), null);
    assert.equal(adaptGame({ questions: "nope" }), null);
    assert.equal(adaptGame(null), null);
    const withHint = adaptGame({ topic: "t", questions: [goodQ(0, { hint: "" }), goodQ(1), goodQ(2, { emoji: "🌋" })] });
    assert.equal(withHint.questions[0].hint, "Think about what you know and pick the best answer.");
    assert.ok(withHint.questions[2].text.startsWith("🌋 "));
    assert.ok(withHint.questions.every((q) => q.custom === true && q.topic === "custom" && q.videoWord === "t"));
  });

  test("My games: list rows, play, malformed question skipped, < 3 valid shows the can't-be-played message", async () => {
    const uid = "mg" + tag;
    const env = await boot(uid);
    await env.enter();
    env.$("myGamesBtn").click();
    await waitFor(() => /No games yet/.test(env.$("gameList").textContent), "empty state");
    const malformed = [goodQ(0), goodQ(1), goodQ(2), { id: "q4", text: "Broken one has no options", correctIndex: 0 }, goodQ(4, { correctIndex: 9 }), goodQ(5, { options: ["same", "SAME", "x"] })];
    await seedGame(uid, "mixed" + tag, { title: "Mixed game", questions: malformed, questionCount: malformed.length });
    await seedGame(uid, "tiny" + tag, { title: "Tiny game", createdAt: new Date(Date.now() - 5000), questions: [goodQ(0), goodQ(1), { text: "bad" }], questionCount: 3 });
    env.$("myGamesCloseBtn").click();
    env.$("myGamesBtn").click();
    await waitFor(() => env.doc.querySelectorAll("#gameList .game-row").length === 2, "two rows");
    const rows = [...env.doc.querySelectorAll("#gameList .game-row")];
    assert.match(rows[0].textContent, /Mixed game/); // newest first
    assert.match(rows[0].textContent, /Science · seeded topic · 6 questions/);
    rows[1].querySelector("button").click();
    assert.equal(env.$("gameMsg").textContent, "This game can't be played. Try making another one!");
    assert.deepEqual(env.shown(), ["myGames"]);
    assert.equal(env.mq.customRun, null);
    rows[0].querySelector("button").click();
    assert.equal(env.mq.state, "playing");
    const served = new Set();
    for (let i = 0; i < 30; i++) { env.fight(); served.add(env.mq.currentQuestion.text); }
    assert.deepEqual([...served].sort(), [goodQ(0).text, goodQ(1).text, goodQ(2).text].sort());
  });

  test("model text such as <img onerror> renders as text, never as an element", async () => {
    const uid = "xss" + tag;
    const env = await boot(uid);
    await env.enter();
    const evil = '<img src=x onerror="window.__pwn=1">';
    const qs = [0, 1, 2].map((i) => goodQ(i, { text: evil + " q" + i, options: [evil + "a", "<b>b</b>" + i, "c" + i], correctIndex: 0, hint: evil + " hint", explanation: evil + " why", emoji: null }));
    await seedGame(uid, "evil" + tag, { title: evil + " title", subject: "<i>Sci</i>", topic: "<u>topic</u>", questions: qs, questionCount: 3 });
    env.$("myGamesBtn").click();
    await waitFor(() => env.doc.querySelectorAll("#gameList .game-row").length === 1 && !/Loading/.test(env.$("gameList").textContent), "row");
    assert.equal(env.doc.querySelectorAll("#gameList img, #gameList b, #gameList i, #gameList u").length, 0);
    assert.ok(env.$("gameList").textContent.includes(evil + " title"), env.$("gameList").textContent);
    env.$("gameList").querySelector("button").click();
    env.fight();
    assert.equal(env.doc.querySelectorAll("#question img, #answers img, #answers b, #hint img, #feedback img").length, 0);
    assert.ok(env.$("question").textContent.includes(evil));
    env.$("mathHelpBtn").click();
    assert.ok(env.$("hint").textContent.includes(evil));
    env.answerRight();
    assert.equal(env.doc.querySelectorAll("#feedback img").length, 0);
    assert.ok(env.$("feedback").textContent.includes(evil + " why"));
    assert.equal(env.win.__pwn, undefined);
  });

  test("custom-run isolation: saved level/best/mega/ultra never change through level clear, game over, retry, logout and a later regular Play", async () => {
    const base = { level: 4, best: 5, megaGemsCollected: 2, ultraGemsCollected: 1 };
    const same = (p) => p.level === 4 && p.best === 5 && p.megaGemsCollected === 2 && p.ultraGemsCollected === 1;
    const env = await boot("iso" + tag, base);
    await env.enter();
    await env.build("tell me about volcanoes");
    assert.deepEqual([env.mq.level, env.mq.best, env.mq.mega, env.mq.ultra], [4, 5, 2, 1]);
    env.$("cgPlayBtn").click();
    assert.ok(env.mq.customRun, "custom run active");
    assert.equal(env.mq.level, 1);
    // level clear (custom level restarts at 1; clearing advances the in-run level only)
    env.clearLevel();
    assert.ok(env.mq.score > 5, "score went above the saved best");
    assert.equal(env.mq.level, 2);
    assert.equal(env.$("levelClearText").textContent, "Great run! This was a custom game, so your regular progress was not changed.");
    assert.equal(env.$("best").textContent, "5", "HUD best stays the saved best");
    env.$("nextLevelBtn").click();
    assert.equal(env.mq.state, "playing");
    // game over + retry
    env.loseGame();
    assert.match(env.$("gameOverText").textContent, /custom game, so your regular progress was not changed/);
    assert.ok(!/Your level \(/.test(env.$("gameOverText").textContent));
    env.$("retryBtn").click();
    assert.equal(env.mq.state, "playing");
    // extra mega gem path: pile up lives so the milestone rewards fire inside the run
    env.mq.lives = 30; env.fight(); env.answerRight(); env.flush();
    assert.ok(env.mq.mega > 2 || env.mq.ultra > 1, "in-memory gem counters moved during the run");
    env.flush();
    assert.ok(env.saves.length > 0, "saves were recorded");
    assert.ok(env.saves.every(same), JSON.stringify(env.saves.filter((p) => !same(p))));
    // back to the menu and a regular Play restores the saved values in memory
    const before = env.saves.length;
    env.$("createGameBtn").click();
    env.$("cgCloseBtn").click();
    env.$("startBtn").click();
    assert.equal(env.mq.customRun, null);
    assert.deepEqual([env.mq.level, env.mq.best, env.mq.mega, env.mq.ultra], [4, 5, 2, 1]);
    assert.equal(env.mq.state, "playing");
    env.fight(); env.answerRight(); env.flush(); // regular run saves normally again
    assert.ok(env.saves.length > before);
    assert.equal(env.saves[env.saves.length - 1].level, 4);
    // the regular run earned real progress; that is the new saved snapshot
    const snap = { level: env.mq.level, best: env.mq.best, mega: env.mq.mega, ultra: env.mq.ultra };
    assert.ok(snap.best > 5, "regular play does save a higher best");
    const same2 = (p) => p.level === snap.level && p.best === snap.best && p.megaGemsCollected === snap.mega && p.ultraGemsCollected === snap.ultra;
    // a fresh custom run, then logout mid-run
    const secondStart = env.saves.length;
    env.$("createGameBtn").click();
    env.$("cgPlayBtn").click();
    assert.ok(env.mq.customRun);
    env.clearLevel();
    const beforeLogout = env.saves.length;
    env.$("logoutBtn").click();
    await waitFor(() => env.loggedOut && env.$("auth").classList.contains("show"), "logout");
    env.flush();
    assert.ok(env.saves.length > beforeLogout, "logout wrote a final save");
    assert.ok(env.saves.slice(secondStart).every(same2), "saves after the second custom run starts equal the snapshot");
    assert.equal(env.mq.customRun, null);
    assert.deepEqual([env.mq.level, env.mq.best, env.mq.mega, env.mq.ultra], [snap.level, snap.best, snap.mega, snap.ultra]);
  });
}

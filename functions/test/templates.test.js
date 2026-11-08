"use strict";
// Template tests: loads the real MQ-VISUALS, MQ-CUSTOM and MQ-TEMPLATES regions of index.html into jsdom
// (no browser, no emulators) with fake timers / animation frames.
// Run: node --test functions/test/templates.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const region = (name) => INDEX.slice(INDEX.indexOf(`/* MQ-${name}:BEGIN */`), INDEX.indexOf(`/* MQ-${name}:END */`) + name.length + 13);
const TPL_REGION = region("TEMPLATES");
const stripComments = (s) => s.replace(/\/\/ .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ---- fake clock / rAF / matchMedia ----
function makeEnv({ reduce = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="tpl" class="overlay"><div id="tplBody"></div></div></body>');
  const document = dom.window.document;
  let hidden = false;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  const fake = { timers: new Map(), frames: new Map(), n: 0, now: 0 };
  const win = {
    setTimeout: (fn, ms) => { const id = ++fake.n; fake.timers.set(id, { fn, at: fake.now + ms }); return id; },
    clearTimeout: (id) => { fake.timers.delete(id); },
    requestAnimationFrame: (fn) => { const id = ++fake.n; fake.frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { fake.frames.delete(id); },
    matchMedia: () => ({ matches: reduce }),
  };
  const calls = [];
  const root = document.getElementById("tpl");
  const origAdd = root.addEventListener.bind(root), origRem = root.removeEventListener.bind(root);
  let listeners = 0;
  root.addEventListener = (t, f, o) => { listeners++; origAdd(t, f, o); };
  root.removeEventListener = (t, f, o) => { listeners--; origRem(t, f, o); };
  const code = region("VISUALS") + "\n" + region("CUSTOM") + "\n" + TPL_REGION +
    "\nreturn { TEMPLATE_META, adaptGame, adaptTemplateGame, mountTemplate, tplTeardown, tplStarsFor, tplReady, reduceMotion, COPY };";
  const M = new Function("document", "window", "console", code)(document, win, { warn() {} });
  const api = { home: () => calls.push("home"), myGames: () => calls.push("myGames"), sound: (k) => calls.push("sound:" + k) };
  const tickFrames = (t) => { const fs2 = [...fake.frames.entries()]; fake.frames.clear(); fs2.forEach(([, fn]) => fn(t)); };
  return { dom, document, win, fake, M, api, calls, root, listeners: () => listeners, setHidden: (v) => { hidden = v; }, tickFrames,
    body: document.getElementById("tplBody") };
}
const Q = (i, extra) => ({ id: "q" + i, text: "Question number " + i + " here?", options: ["right" + i, "wrongA" + i, "wrongB" + i], correctIndex: 0,
  hint: "Hint " + i, explanation: "Because " + i, emoji: "🍎", ...extra });
const gameDef = (n, over) => ({ schemaVersion: 2, type: "picturequiz", id: "g1", title: "Fruit Fun", topic: "fruit", subject: "Math",
  questions: Array.from({ length: n }, (_, i) => Q(i + 1)), ...over });
const byText = (root, sel, re) => [...root.querySelectorAll(sel)].find((b) => re.test(b.textContent));
const qText = (env) => env.body.querySelector(".tpl-q").textContent;
const raw = (def, text) => def.questions.find((q) => q.text === text);
function clickAnswer(env, def, right) {
  const q = raw(def, qText(env));
  const want = right ? q.options[q.correctIndex] : q.options.find((o, i) => i !== q.correctIndex);
  const b = [...env.body.querySelectorAll(".tpl-ans")].find((x) => x.querySelector(".tpl-ans-text").textContent === want);
  b.click();
}
function nextOrResults(env) {
  const b = byText(env.body, ".tpl-controls button", /^(Next|See results)$/);
  assert.ok(b && !b.hidden, "next button visible");
  b.click();
}
const title = (env) => env.body.querySelector(".tpl-rtitle");
const play = (env, def, rights) => { // rights: array of booleans, one per question answered
  const g = env.M.adaptGame(def);
  assert.ok(env.M.mountTemplate(g, env.api));
  rights.forEach((r) => { clickAnswer(env, def, r); nextOrResults(env); });
  return g;
};

test("TEMPLATES region: no progress identifiers and no innerHTML", () => {
  const code = stripComments(TPL_REGION);
  assert.ok(code.length > 2000);
  const bad = code.match(/\b(level|lives|score|bestScore|gems|megaGemsCollected|ultraGemsCollected|persistProgress|saveProfile|submitBestToCloud|customRun)\b/g);
  assert.equal(bad, null);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
});

test("star math", () => {
  const { tplStarsFor } = makeEnv().M;
  assert.equal(tplStarsFor(10, 10, 0), 3);
  assert.equal(tplStarsFor(9, 10, 0), 3);
  assert.equal(tplStarsFor(10, 10, 1), 2);
  assert.equal(tplStarsFor(6, 10, 0), 2);
  assert.equal(tplStarsFor(5, 10, 0), 1);
  assert.equal(tplStarsFor(0, 4, 0), 1);
});

test("picturequiz win: all right = 3 stars, results screen with three buttons", () => {
  const env = makeEnv();
  const def = gameDef(4);
  play(env, def, [true, true, true, true]);
  assert.equal(title(env).textContent, env.M.COPY.tplWin);
  assert.equal(env.body.querySelector(".tpl-stars").getAttribute("aria-label"), "3 of 3 stars");
  const labels = [...env.body.querySelectorAll(".tpl-controls button")].map((b) => b.textContent);
  assert.deepEqual(labels.map((l) => l.replace(/^\S+\s/, "")), ["Play again", "My games", "Back to home"]);
  assert.match(env.body.textContent, /do not change your saved score/);
  assert.equal(env.document.activeElement, title(env));
});

test("picturequiz lose: three wrong answers end the run with review lines", () => {
  const env = makeEnv();
  const def = gameDef(5);
  play(env, def, [false, false, false]);
  assert.equal(title(env).textContent, env.M.COPY.tplLose);
  assert.equal(env.body.querySelector(".tpl-stars").getAttribute("aria-label"), "1 of 3 stars");
  assert.match(env.body.textContent, /0 of 5 right/);
  assert.match(env.body.textContent, /Question number \d here\? → right\d/);
});

test("picturequiz complete with one miss: 3 of 4 right = 2 stars, answer and explanation shown after each pick", () => {
  const env = makeEnv();
  const def = gameDef(4);
  const g = env.M.adaptGame(def);
  env.M.mountTemplate(g, env.api);
  clickAnswer(env, def, false);
  const live = env.body.querySelector(".tpl-live").textContent;
  assert.match(live, /Not quite\. The answer is right\d\./);
  assert.match(live, /Because \d/);
  assert.equal(env.body.querySelectorAll(".tpl-ans.wrong").length, 1);
  assert.equal(env.body.querySelectorAll(".tpl-ans.right").length, 1);
  assert.match(env.body.querySelector(".tpl-ans.wrong").textContent, /^✗/);
  nextOrResults(env);
  for (let k = 0; k < 3; k++) { clickAnswer(env, def, true); nextOrResults(env); }
  assert.equal(env.body.querySelector(".tpl-stars").getAttribute("aria-label"), "2 of 3 stars");
});

test("hint shows the stored hint and costs the third star; extra answer clicks are ignored", () => {
  const env = makeEnv();
  const def = gameDef(3);
  const g = env.M.adaptGame(def);
  env.M.mountTemplate(g, env.api);
  byText(env.body, ".tpl-controls button", /Hint/).click();
  assert.match(env.body.querySelector(".tpl-live").textContent, /^💡 Hint \d/);
  clickAnswer(env, def, true);
  clickAnswer(env, def, false); // ignored: already answered
  assert.equal(env.body.querySelectorAll(".tpl-ans.wrong").length, 0);
  nextOrResults(env);
  for (let k = 0; k < 2; k++) { clickAnswer(env, def, true); nextOrResults(env); }
  assert.equal(env.body.querySelector(".tpl-stars").getAttribute("aria-label"), "2 of 3 stars");
});

test("replay starts a fresh run; home and My games callbacks fire", () => {
  const env = makeEnv();
  const def = gameDef(3);
  play(env, def, [true, true, true]);
  byText(env.body, ".tpl-controls button", /Play again/).click();
  assert.match(env.body.querySelector(".tpl-status").textContent, /^1\/3/);
  assert.equal(env.body.querySelector(".tpl-rtitle"), null);
  play(env, def, [true, true, true]);
  byText(env.body, ".tpl-controls button", /My games/).click();
  byText(env.body, ".tpl-controls button", /Back to home/).click();
  assert.deepEqual(env.calls, ["myGames", "home"]);
  // the header home button also calls home
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  env.body.querySelector(".tpl-head .tpl-btn").click();
  assert.deepEqual(env.calls, ["myGames", "home", "home"]);
});

test("keys 1-3 pick an answer; typing in an input is ignored", () => {
  const env = makeEnv();
  const def = gameDef(3);
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  const input = env.document.createElement("input");
  env.root.appendChild(input);
  input.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "1", bubbles: true }));
  assert.equal(env.body.querySelectorAll(".tpl-ans.right").length, 0);
  env.root.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "2", bubbles: true }));
  assert.equal(env.body.querySelectorAll(".tpl-ans.right").length, 1);
  assert.equal(env.body.querySelectorAll(".tpl-ans[aria-disabled=\"true\"]").length, 3);
});

test("sound is off until the header toggle is pressed, then maps onto the sfx names", () => {
  const env = makeEnv();
  const def = gameDef(3);
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  clickAnswer(env, def, true);
  assert.deepEqual(env.calls, []);
  nextOrResults(env);
  byText(env.body, ".tpl-head button", /Sound/).click();
  clickAnswer(env, def, false);
  assert.deepEqual(env.calls, ["sound:wrong"]);
});

test("catch: bubbles drift, the 12 second timer costs a heart, hidden tab pauses it", () => {
  const env = makeEnv();
  const def = gameDef(4, { type: "catch" });
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  assert.equal(env.root.getAttribute("data-tpl"), "catch");
  const sea = env.body.querySelector(".tpl-sea");
  assert.ok(sea && !sea.classList.contains("calm"));
  const first = env.body.querySelector(".tpl-bubble");
  const x0 = first.style.left;
  env.setHidden(true);
  let t = 1000;
  for (let k = 0; k < 400; k++) { t += 50; env.tickFrames(t); }
  assert.equal(env.body.querySelector(".tpl-timer").textContent, "⏱ 12");
  assert.equal(first.style.left, x0);
  env.setHidden(false);
  for (let k = 0; k < 20; k++) { t += 50; env.tickFrames(t); }
  assert.notEqual(first.style.left, x0);
  for (let k = 0; k < 400 && !env.body.querySelector(".tpl-live").textContent; k++) { t += 50; env.tickFrames(t); }
  assert.match(env.body.querySelector(".tpl-live").textContent, /Time is up!/);
  assert.match(env.body.querySelector(".tpl-status").textContent, /🤍/);
  assert.equal(env.fake.frames.size, 0);
});

test("catch with reduced motion: static calm row, no timer, no animation frames", () => {
  const env = makeEnv({ reduce: true });
  const def = gameDef(3, { type: "catch" });
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  assert.ok(env.body.querySelector(".tpl-sea.calm"));
  assert.equal(env.fake.frames.size, 0);
  assert.ok(!/⏱/.test(env.body.textContent));
  assert.equal(byText(env.body, ".tpl-controls button", /Calm/).disabled, true);
  clickAnswer(env, def, true);
  assert.match(env.body.querySelector(".tpl-live").textContent, /^Right!/);
});

test("catch calm toggle switches to a static row without a timer", () => {
  const env = makeEnv();
  const def = gameDef(3, { type: "catch" });
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  assert.ok(env.fake.frames.size > 0);
  byText(env.body, ".tpl-controls button", /Calm/).click();
  assert.ok(env.body.querySelector(".tpl-sea.calm"));
  assert.ok(!/⏱/.test(env.body.textContent));
  env.tickFrames(5000); // a stale frame from before the toggle does nothing
  assert.equal(env.fake.frames.size, 0);
});

test("teardown cancels timers, frames and listeners and empties the screen", () => {
  const env = makeEnv();
  const def = gameDef(4, { type: "catch" });
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  env.win.setTimeout(() => {}, 10);
  assert.ok(env.fake.frames.size > 0);
  assert.equal(env.listeners(), 1);
  env.M.tplTeardown();
  assert.equal(env.fake.frames.size, 0);
  assert.equal(env.listeners(), 0);
  assert.equal(env.body.childNodes.length, 0);
  assert.equal(env.root.getAttribute("data-tpl"), "");
  // remounting does not stack listeners
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  env.M.mountTemplate(env.M.adaptGame(def), env.api);
  assert.equal(env.listeners(), 1);
  env.M.tplTeardown();
  assert.equal(env.listeners(), 0);
});

test("pictures: a question with a picture draws an svg; a broken picture drops the question", () => {
  const env = makeEnv();
  const good = { kind: "pie", parts: 8, shaded: 3, theme: "pizza" };
  const def = gameDef(4, { questions: [Q(1, { visual: good }), Q(2), Q(3), Q(4, { visual: { kind: "pie", parts: 8, shaded: 99 } })] });
  const g = env.M.adaptGame(def);
  // the 4th question carries a broken picture: adaptGame already dropped it
  assert.equal(g.questions.length, 3);
  const qs = [];
  env.M.mountTemplate(g, env.api);
  for (let k = 0; k < 3; k++) {
    qs.push(!!env.body.querySelector(".tpl-pic svg"));
    clickAnswer(env, def, true); nextOrResults(env);
  }
  assert.equal(qs.filter(Boolean).length, 1);
});

test("hostile model text stays text", () => {
  const env = makeEnv();
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  const def = gameDef(3, { title: evil, questions: [1, 2, 3].map((i) => Q(i, { text: evil + i, options: [evil + "a", "b" + i, "c" + i], explanation: evil, hint: evil })) });
  const g = env.M.adaptGame(def);
  env.M.mountTemplate(g, env.api);
  byText(env.body, ".tpl-controls button", /Hint/).click();
  env.body.querySelector(".tpl-ans").click();
  assert.equal(env.body.querySelector("img"), null);
  assert.equal(env.body.querySelector("script"), null);
  assert.ok(env.body.textContent.includes("<img src=x"));
});

test("unplayable games do not mount; a choice payload under type memory is not playable; v1 and unknown types", () => {
  const env = makeEnv();
  assert.equal(env.M.mountTemplate(null, env.api), false);
  assert.equal(env.M.tplReady(env.M.adaptGame(gameDef(3))), true);
  assert.equal(env.M.adaptGame(gameDef(3, { type: "memory" })), null);
  assert.equal(env.M.adaptGame(gameDef(3, { type: "nonsense" })), null);
  assert.equal(env.M.adaptGame(gameDef(3, { schemaVersion: 3 })), null);
  assert.equal(env.M.adaptGame(gameDef(2)), null);
  const v1 = gameDef(3); delete v1.type; v1.schemaVersion = 1;
  assert.equal(env.M.adaptGame(v1).type, "quiz");
  assert.equal(env.M.tplReady(env.M.adaptGame(v1)), false);
  assert.equal(env.M.adaptGame(gameDef(3, { type: "quiz" })).type, "quiz");
  assert.equal(env.M.TEMPLATE_META.catch.name, "Bubble Pop");
});

// ================= FEAT-004: memory, sequence, sort =================
const advance = (env, ms) => {
  env.fake.now += ms;
  [...env.fake.timers.entries()].filter(([, t]) => t.at <= env.fake.now).sort((a, b) => a[1].at - b[1].at)
    .forEach(([id, t]) => { if (env.fake.timers.delete(id)) t.fn(); });
};
const withRandom = (v, fn) => { const old = Math.random; Math.random = () => v; try { return fn(); } finally { Math.random = old; } };
const live = (env) => env.body.querySelector(".tpl-live").textContent;
const resultsStars = (env) => env.body.querySelector(".tpl-stars").getAttribute("aria-label");
const threeButtons = (env) => [...env.body.querySelectorAll(".tpl-results ~ .tpl-controls button, .tpl-controls button")].map((b) => b.textContent.replace(/^\S+\s/, ""));

const memDef = (n, over) => ({ schemaVersion: 2, type: "memory", id: "m1", title: "Pairs", topic: "fractions", subject: "Math",
  pairs: Array.from({ length: n }, (_, i) => ({ id: "p" + (i + 1), a: { label: "Aa" + i }, b: { label: "Bb" + i, emoji: "🍕" }, hint: "Memory hint " + i, explanation: "Pair " + i + " goes together." })), ...over });
// With Math.random fixed at 0 the 3-pair deck is [p0b, p1a, p1b, p2a, p2b, p0a].
const memStart = (def) => { const env = makeEnv(); const g = env.M.adaptGame(def); withRandom(0, () => env.M.mountTemplate(g, env.api)); return env; };
const cardsOf = (env) => [...env.body.querySelectorAll(".tpl-flip")];
const flipPair = (env, a, b) => { const c = cardsOf(env); c[a].click(); c[b].click(); };

test("memory: 2n face-down toggle buttons with labels, 3 pairs minimum", () => {
  const env = memStart(memDef(3));
  const c = cardsOf(env);
  assert.equal(c.length, 6);
  c.forEach((b, k) => { assert.equal(b.tagName, "BUTTON"); assert.equal(b.getAttribute("aria-pressed"), "false"); assert.equal(b.getAttribute("aria-label"), "Card " + (k + 1) + ", face down"); });
  assert.equal(env.root.getAttribute("data-tpl"), "memory");
  assert.match(env.body.querySelector(".tpl-instr").textContent, /Flip two cards/);
  assert.equal(env.M.adaptGame(memDef(2)), null);
  assert.equal(env.M.tplReady(env.M.adaptGame(memDef(2))), false);
  assert.equal(env.M.tplReady(env.M.adaptGame(memDef(3))), true);
  assert.equal(env.M.mountTemplate(env.M.adaptTemplateGame(memDef(3, { pairs: [] })), env.api), false);
});

test("memory: match stays up with explanation; perfect game = 3 moves = 3 stars with three result buttons", () => {
  const env = memStart(memDef(3));
  flipPair(env, 1, 2); // p1a + p1b
  let c = cardsOf(env);
  assert.equal(c[1].getAttribute("aria-label"), "Card 2: Aa1, matched");
  assert.equal(c[2].getAttribute("aria-label"), "Card 3: Bb1, matched");
  assert.equal(c[1].getAttribute("aria-pressed"), "true");
  assert.match(live(env), /A match! Pair 1 goes together\./);
  c[1].click(); // matched card: ignored
  assert.equal(env.body.querySelector(".tpl-status").textContent, "Moves 1 · Pairs 1/3");
  flipPair(env, 3, 4);
  assert.equal(byText(env.body, ".tpl-controls button", /See results/).hidden, true);
  flipPair(env, 0, 5);
  const done = byText(env.body, ".tpl-controls button", /See results/);
  assert.equal(done.hidden, false);
  assert.equal(env.document.activeElement, done);
  done.click();
  assert.equal(title(env).textContent, env.M.COPY.tplWin);
  assert.equal(resultsStars(env), "3 of 3 stars");
  assert.match(env.body.textContent, /3 pairs found in 3 moves/);
  assert.deepEqual(threeButtons(env), ["Play again", "My games", "Back to home"]);
});

test("memory: mismatch locks the board, flips back after 1200 ms; stars follow the move count", () => {
  const env = memStart(memDef(3));
  flipPair(env, 0, 1); // p0b + p1a: not a pair
  let c = cardsOf(env);
  assert.match(live(env), /Not a pair/);
  c[2].click(); // locked
  assert.equal(c[2].getAttribute("aria-pressed"), "false");
  advance(env, 1100);
  assert.equal(c[0].getAttribute("aria-pressed"), "true");
  advance(env, 100);
  assert.equal(c[0].getAttribute("aria-pressed"), "false");
  assert.equal(c[1].getAttribute("aria-label"), "Card 2, face down");
  c[2].click();
  assert.equal(c[2].getAttribute("aria-pressed"), "true");
  c[2].click(); // same face-up card twice does nothing
  assert.equal(env.body.querySelector(".tpl-status").textContent, "Moves 1 · Pairs 0/3");
  // 2 stars: three misses + three matches = 6 moves (n*2)
  const two = memStart(memDef(3));
  [[0, 1], [0, 2], [0, 3]].forEach(([a, b]) => { flipPair(two, a, b); advance(two, 1200); });
  flipPair(two, 1, 2); flipPair(two, 3, 4); flipPair(two, 0, 5);
  byText(two.body, ".tpl-controls button", /See results/).click();
  assert.equal(resultsStars(two), "2 of 3 stars");
  // 1 star: four misses + three matches = 7 moves
  const one = memStart(memDef(3));
  [[0, 1], [0, 2], [0, 3], [0, 4]].forEach(([a, b]) => { flipPair(one, a, b); advance(one, 1200); });
  flipPair(one, 1, 2); flipPair(one, 3, 4); flipPair(one, 0, 5);
  byText(one.body, ".tpl-controls button", /See results/).click();
  assert.equal(resultsStars(one), "1 of 3 stars");
});

test("memory: hint shows the pair hint; two hints cost a star; replay and callbacks", () => {
  const env = memStart(memDef(3));
  const hint = byText(env.body, ".tpl-controls button", /Hint/);
  cardsOf(env)[1].click(); // p1a face up: hint is about its pair
  hint.click();
  assert.match(live(env), /^💡 Memory hint 1$/);
  cardsOf(env)[2].click();
  hint.click(); hint.click();
  flipPair(env, 3, 4); flipPair(env, 0, 5);
  byText(env.body, ".tpl-controls button", /See results/).click();
  assert.equal(resultsStars(env), "2 of 3 stars");
  byText(env.body, ".tpl-controls button", /Play again/).click();
  assert.equal(cardsOf(env).length, 6);
  assert.ok(cardsOf(env).every((b) => b.getAttribute("aria-pressed") === "false"));
  env.M.mountTemplate(env.M.adaptGame(memDef(3)), env.api);
  env.body.querySelector(".tpl-head .tpl-icon").click();
  assert.deepEqual(env.calls, ["home"]);
});

test("memory: roving arrow keys, 3 columns at phone width in the CSS, teardown cancels the back-flip", () => {
  const env = memStart(memDef(3));
  const c = cardsOf(env);
  c[0].focus();
  c[0].dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(env.document.activeElement, c[1]);
  c[1].dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  assert.equal(env.document.activeElement, c[0]);
  assert.match(INDEX, /@media \(max-width: 480px\) \{ \.tpl-grid \{ grid-template-columns: repeat\(3, 1fr\); \} \}/);
  flipPair(env, 0, 1);
  assert.equal(env.fake.timers.size, 1);
  env.M.tplTeardown();
  assert.equal(env.fake.timers.size, 0);
  assert.equal(env.body.childNodes.length, 0);
});

test("memory: a side with a picture draws an svg; a pair with a broken picture is dropped", () => {
  const pie = { kind: "pie", parts: 2, shaded: 1, theme: "pizza" };
  const def = memDef(4);
  def.pairs[0].b = { label: "Half a pizza", visual: pie };
  const env = memStart(def);
  assert.equal(env.body.querySelectorAll(".tpl-flip svg").length, 0); // still face down
  const g = env.M.adaptGame(def);
  env.M.mountTemplate(g, env.api);
  let drawn = 0;
  for (let k = 0; k < 8 && !drawn; k += 2) { flipPair(env, k, k + 1); drawn = env.body.querySelectorAll(".tpl-flip svg").length; advance(env, 1200); }
  assert.ok(drawn >= 1);
  const bad = memDef(4);
  bad.pairs[0].b = { label: "Broken", visual: { kind: "pie", parts: 4, shaded: 9 } };
  assert.equal(env.M.adaptGame(bad).pairs.length, 3);
  const bad2 = memDef(3);
  bad2.pairs[1].a = { label: "Broken", visual: { kind: "barChart", bars: [] } }; // wrong host kind too
  assert.equal(env.M.adaptGame(bad2), null);
});

// ---- sequence ----
const seqDef = (nRounds, over) => ({ schemaVersion: 2, type: "sequence", id: "s1", title: "Order", topic: "water", subject: "Science",
  rounds: Array.from({ length: nRounds }, (_, r) => ({ id: "r" + (r + 1), prompt: "Put round " + (r + 1) + " in order",
    steps: ["One" + r, "Two" + r, "Three" + r].map((l, i) => ({ label: l, emoji: ["☀️", "☁️", "🌧️"][i] })),
    hint: "Sequence hint " + r, explanation: "Round " + r + " goes one two three." })), ...over });
const seqStart = (def, rnd) => { const env = makeEnv(); const g = env.M.adaptGame(def); withRandom(rnd === undefined ? 0 : rnd, () => env.M.mountTemplate(g, env.api)); return env; };
const trayBtn = (env, label) => [...env.body.querySelectorAll(".tpl-tray button")].find((b) => b.getAttribute("aria-label").startsWith(label + "."));
const slotBtn = (env, k) => env.body.querySelectorAll(".tpl-slot")[k].querySelector("button");
const placeOrder = (env, labels) => labels.forEach((l) => trayBtn(env, l).click());
const checkBtnOf = (env) => byText(env.body, ".tpl-controls button", /^Check$/);
const nextBtnOf = (env) => byText(env.body, ".tpl-controls button", /^(Next|See results)$/);

test("sequence: tray never starts in the correct order, even when the shuffle would keep it", () => {
  const env = seqStart(seqDef(2), 0.9999); // random ~1 keeps the identity order; the guard must change it
  const labels = [...env.body.querySelectorAll(".tpl-tray button")].map((b) => b.getAttribute("aria-label").split(".")[0]);
  assert.equal(labels.length, 3);
  assert.notDeepEqual(labels, ["One0", "Two0", "Three0"]);
  assert.deepEqual([...labels].sort(), ["One0", "Three0", "Two0"]);
  assert.equal(env.root.getAttribute("data-tpl"), "sequence");
  assert.equal(env.body.querySelector(".tpl-status").textContent, "Round 1 of 2");
  assert.equal(checkBtnOf(env).disabled, true);
});

test("sequence: place, return, check; perfect game = 3 stars with three result buttons", () => {
  const env = seqStart(seqDef(2));
  trayBtn(env, "Two0").click();
  assert.match(slotBtn(env, 0).getAttribute("aria-label"), /^Slot 1: Two0\. Press to return/);
  slotBtn(env, 0).click(); // return it
  assert.equal(env.body.querySelectorAll(".tpl-tray button").length, 3);
  assert.equal(env.body.querySelectorAll(".tpl-slot button").length, 0);
  placeOrder(env, ["One0", "Two0"]);
  assert.equal(checkBtnOf(env).disabled, true);
  placeOrder(env, ["Three0"]);
  assert.equal(checkBtnOf(env).disabled, false);
  checkBtnOf(env).click();
  assert.match(live(env), /right order! 💡 Round 0 goes one two three\./);
  assert.equal(nextBtnOf(env).textContent, "Next");
  slotBtn(env, 0).click(); // locked: ignored
  assert.equal(env.body.querySelectorAll(".tpl-slot button").length, 3);
  nextBtnOf(env).click();
  assert.equal(env.body.querySelector(".tpl-status").textContent, "Round 2 of 2");
  placeOrder(env, ["One1", "Two1", "Three1"]);
  checkBtnOf(env).click();
  assert.equal(nextBtnOf(env).textContent, "See results");
  nextBtnOf(env).click();
  assert.equal(title(env).textContent, env.M.COPY.tplWin);
  assert.equal(resultsStars(env), "3 of 3 stars");
  assert.match(env.body.textContent, /2 of 2 rounds right on the first try/);
  assert.deepEqual(threeButtons(env), ["Play again", "My games", "Back to home"]);
});

test("sequence: wrong slots return to the tray, right ones lock; attempts set the stars (average, min 1)", () => {
  const env = seqStart(seqDef(2));
  placeOrder(env, ["Three0", "Two0", "One0"]); // middle one is right
  checkBtnOf(env).click();
  assert.match(live(env), /^✗ 1 in the right place/);
  assert.equal(env.body.querySelectorAll(".tpl-tray button").length, 2);
  assert.equal(slotBtn(env, 1).getAttribute("aria-disabled"), "true");
  assert.match(slotBtn(env, 1).getAttribute("aria-label"), /Correct\.$/);
  assert.equal(checkBtnOf(env).disabled, true);
  placeOrder(env, ["Three0"]); // lands in the first empty slot (1) -> wrong again
  placeOrder(env, ["One0"]);
  checkBtnOf(env).click();
  assert.match(live(env), /^✗ /);
  placeOrder(env, ["One0", "Three0"]);
  checkBtnOf(env).click();
  assert.match(live(env), /right order/);
  nextBtnOf(env).click();
  placeOrder(env, ["One1", "Two1", "Three1"]);
  checkBtnOf(env).click();
  nextBtnOf(env).click();
  // round 1 took 3 attempts (1 star), round 2 first try (3 stars): floor(4/2) = 2
  assert.equal(resultsStars(env), "2 of 3 stars");
  assert.match(env.body.textContent, /1 of 2 rounds right on the first try/);
});

test("sequence: hint, replay, teardown, minimum rounds, malformed step drops the round", () => {
  const env = seqStart(seqDef(2));
  byText(env.body, ".tpl-controls button", /Hint/).click();
  assert.match(live(env), /^💡 Sequence hint 0$/);
  placeOrder(env, ["One0", "Two0", "Three0"]); checkBtnOf(env).click(); nextBtnOf(env).click();
  placeOrder(env, ["One1", "Two1", "Three1"]); checkBtnOf(env).click(); nextBtnOf(env).click();
  byText(env.body, ".tpl-controls button", /Play again/).click();
  assert.equal(env.body.querySelector(".tpl-status").textContent, "Round 1 of 2");
  env.M.tplTeardown();
  assert.equal(env.body.childNodes.length, 0);
  assert.equal(env.listeners(), 0);
  assert.equal(env.M.adaptGame(seqDef(1)), null);
  const bad = seqDef(3);
  bad.rounds[0].steps[1] = { label: "Oops", visual: { kind: "clock", hour: 99, minute: 0 } };
  assert.equal(env.M.adaptGame(bad).rounds.length, 2);
  const bad2 = seqDef(2);
  bad2.rounds[1].steps = [{ label: "Only one" }];
  assert.equal(env.M.adaptGame(bad2), null);
  const keys = seqStart(seqDef(2));
  const tray = keys.body.querySelectorAll(".tpl-tray button");
  tray[0].focus();
  tray[0].dispatchEvent(new keys.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(keys.document.activeElement, tray[1]);
});

// ---- sort ----
const sortDef = (nItems, over) => ({ schemaVersion: 2, type: "sort", id: "t1", title: "Sort", topic: "states", subject: "Science",
  bins: [{ id: "b1", label: "Solid", emoji: "🧊", rule: "Keeps its shape" }, { id: "b2", label: "Liquid", emoji: "💧", rule: "Flows and pours" }],
  items: Array.from({ length: nItems }, (_, i) => ({ id: "i" + (i + 1), label: "Thing" + i, emoji: "🔹", bin: i % 2, explanation: "Thing" + i + " fits." })), ...over });
const sortStart = (def) => { const env = makeEnv(); env.M.mountTemplate(env.M.adaptGame(def), env.api); return env; };
const curItem = (env) => env.body.querySelector(".tpl-item .tpl-q").textContent;
const binOf = (def, label) => def.items.find((i) => i.label === label).bin;
const bins = (env) => [...env.body.querySelectorAll(".tpl-bin")];
const sortRight = (env, def) => bins(env)[binOf(def, curItem(env))].click();
const sortWrong = (env, def) => bins(env)[1 - binOf(def, curItem(env))].click();

test("sort: item card, 2 bin buttons with labels, progressbar; all right = 3 stars, no lose state", () => {
  const def = sortDef(6);
  const env = sortStart(def);
  assert.equal(env.root.getAttribute("data-tpl"), "sort");
  assert.deepEqual(bins(env).map((b) => b.getAttribute("aria-label")), ["Group 1: Solid", "Group 2: Liquid"]);
  const bar = env.body.querySelector("[role=progressbar]");
  assert.equal(bar.getAttribute("aria-valuemax"), "6");
  assert.equal(bar.getAttribute("aria-valuenow"), "0");
  for (let k = 0; k < 5; k++) sortRight(env, def);
  assert.equal(bar.getAttribute("aria-valuenow"), "5");
  assert.match(live(env), /^✅ Thing\d fits\./);
  assert.equal(byText(env.body, ".tpl-controls button", /See results/).hidden, true);
  sortRight(env, def);
  assert.equal(bar.getAttribute("aria-valuenow"), "6");
  assert.match(env.body.querySelector(".tpl-item").textContent, /Everything is sorted!/);
  assert.equal(bins(env)[0].getAttribute("aria-disabled"), "true");
  const done = byText(env.body, ".tpl-controls button", /See results/);
  assert.equal(done.hidden, false);
  done.click();
  assert.equal(title(env).textContent, env.M.COPY.tplWin);
  assert.equal(resultsStars(env), "3 of 3 stars");
  assert.match(env.body.textContent, /6 items sorted with 0 mistakes/);
  assert.deepEqual(threeButtons(env), ["Play again", "My games", "Back to home"]);
});

test("sort: a wrong pick shows the bin rule and re-queues the item; mistakes set the stars", () => {
  const def = sortDef(6);
  const env = sortStart(def);
  const first = curItem(env);
  sortWrong(env, def);
  assert.match(live(env), /^✗ Not quite\. (Solid: Keeps its shape|Liquid: Flows and pours)$/);
  assert.notEqual(curItem(env), first); // went to the back of the queue
  assert.match(env.body.querySelector(".tpl-status").textContent, /Mistakes 1/);
  const play = (wrongs) => {
    const e = sortStart(def);
    for (let k = 0; k < wrongs; k++) sortWrong(e, def);
    for (let k = 0; k < 6; k++) sortRight(e, def);
    byText(e.body, ".tpl-controls button", /See results/).click();
    return resultsStars(e);
  };
  assert.equal(play(1), "3 of 3 stars");
  assert.equal(play(3), "2 of 3 stars");
  assert.equal(play(4), "1 of 3 stars");
  assert.match(env.body.textContent, /Mistakes/);
});

test("sort: keys 1-2 pick a group (not while typing), arrows move focus, hint lists the rules, replay, teardown", () => {
  const def = sortDef(6);
  const env = sortStart(def);
  const input = env.document.createElement("input");
  env.root.appendChild(input);
  const press = (target, key) => target.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  press(input, "1");
  assert.match(env.body.querySelector(".tpl-status").textContent, /^0\/6 · Mistakes 0/);
  press(env.root, String(binOf(def, curItem(env)) + 1));
  assert.match(env.body.querySelector(".tpl-status").textContent, /^1\/6/);
  press(env.root, "3"); // no third group: ignored
  assert.match(env.body.querySelector(".tpl-status").textContent, /^1\/6 · Mistakes 0/);
  bins(env)[0].focus();
  press(bins(env)[0], "ArrowRight");
  assert.equal(env.document.activeElement, bins(env)[1]);
  byText(env.body, ".tpl-controls button", /Hint/).click();
  assert.equal(live(env), "💡 Solid: Keeps its shape · Liquid: Flows and pours");
  for (let k = 0; k < 5; k++) sortRight(env, def);
  byText(env.body, ".tpl-controls button", /See results/).click();
  byText(env.body, ".tpl-controls button", /Play again/).click();
  assert.match(env.body.querySelector(".tpl-status").textContent, /^0\/6/);
  assert.equal(env.listeners(), 1);
  env.M.tplTeardown();
  assert.equal(env.listeners(), 0);
  assert.equal(env.body.childNodes.length, 0);
});

test("sort: minimums, bin range and malformed pictures", () => {
  const env = makeEnv();
  assert.equal(env.M.adaptGame(sortDef(5)), null);
  assert.equal(env.M.tplReady(env.M.adaptGame(sortDef(6))), true);
  assert.equal(env.M.adaptGame(sortDef(7, { bins: [sortDef(1).bins[0]] })), null);
  const four = sortDef(7); four.bins = [...four.bins, { label: "Gas", rule: "Spreads out" }, { label: "Plasma", rule: "Glows hot" }];
  assert.equal(env.M.adaptGame(four), null);
  const range = sortDef(10); range.items[0].bin = 2; range.items[1].bin = -1; range.items[2].bin = 0.5;
  assert.equal(env.M.adaptGame(range).items.length, 7);
  const bad = sortDef(7); bad.items[0].visual = { kind: "clock", hour: 0, minute: 0 };
  assert.equal(env.M.adaptGame(bad).items.length, 6);
  const bad6 = sortDef(6); bad6.items[0].visual = { kind: "shape", shape: "blob" };
  assert.equal(env.M.adaptGame(bad6), null);
  const ok = sortDef(6); ok.items[0].visual = { kind: "clock", hour: 3, minute: 30 };
  const e2 = sortStart(ok);
  const withPic = [];
  for (let k = 0; k < 6; k++) { withPic.push(!!e2.body.querySelector(".tpl-item svg")); sortRight(e2, ok); }
  assert.equal(withPic.filter(Boolean).length, 1);
});

test("memory, sequence and sort: hostile model text stays text", () => {
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  const mem = memDef(3, { title: evil });
  mem.pairs.forEach((p) => { p.a.label = evil + "a"; p.b.label = evil + "b"; p.hint = evil; p.explanation = evil; });
  const seq = seqDef(2, { title: evil });
  seq.rounds.forEach((r) => { r.prompt = evil; r.hint = evil; r.explanation = evil; r.steps.forEach((s, i) => { s.label = evil + i; }); });
  const sor = sortDef(6, { title: evil });
  sor.bins.forEach((b) => { b.label = "<img onerror=1>"; b.rule = evil; });
  sor.items.forEach((i) => { i.label = evil; i.explanation = evil; });
  for (const def of [mem, seq, sor]) {
    const env = makeEnv();
    env.M.mountTemplate(env.M.adaptGame(def), env.api);
    byText(env.body, ".tpl-controls button", /Hint/).click();
    env.body.querySelectorAll("button").forEach((b) => { if (!b.hidden) b.click(); });
    assert.equal(env.body.querySelector("img"), null);
    assert.equal(env.body.querySelector("script"), null);
    assert.ok(env.body.textContent.includes("<img src=x"));
  }
});

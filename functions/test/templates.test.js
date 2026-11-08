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
    "\nreturn { TEMPLATE_META, adaptGame, mountTemplate, tplTeardown, tplStarsFor, tplReady, reduceMotion, COPY };";
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

test("unplayable games do not mount; memory/sequence/sort are not playable yet; v1 and unknown types", () => {
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

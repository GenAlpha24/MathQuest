"use strict";
// Renderer tests: loads the real MQ-VISUALS region of index.html into jsdom (no browser, no emulators).
// Run: node --test functions/test/visuals.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const server = require("../lib/visuals");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const BEGIN = "/* MQ-VISUALS:BEGIN */";
const END = "/* MQ-VISUALS:END */";
const REGION = INDEX.slice(INDEX.indexOf(BEGIN), INDEX.indexOf(END) + END.length);
const CODE = REGION.replace(/\/\/ .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); // comments removed for source scans
const dom = new JSDOM("<!doctype html><body></body>");
const warn = [];
const V = new Function("document", "console", REGION +
  "\nreturn { VIS_LIMITS, EMOJI_DENY, VIS_KINDS, VIS_HOSTS, VIS_KEYS, VIS_EDGES, sanitizeVisual, describeVisual, renderVisual };")(
  dom.window.document, { warn: (m) => warn.push(m) });

const all = (svg, sel) => Array.from(svg.querySelectorAll(sel));
const text = (svg, sel) => all(svg, sel).map((n) => n.textContent);

const GOOD = {
  barChart: { kind: "barChart", title: "Pets in class", yLabel: "Pets", showValues: true,
    bars: [{ label: "Dogs", value: 5, emoji: "🐶" }, { label: "Cats", value: 3 }, { label: "Fish", value: 8 }] },
  pie: { kind: "pie", parts: 8, shaded: 3, theme: "pizza" },
  numberLine: { kind: "numberLine", min: 0, max: 20, step: 2, marks: [6, 14] },
  clock: { kind: "clock", hour: 3, minute: 30, showDigital: true },
  shape: { kind: "shape", shape: "rectangle", sideLabels: [6, 4, 6, 4], lengthUnit: "cm", splitParts: 4, splitShaded: 1 },
  emojiGroup: { kind: "emojiGroup", emoji: "🍎", count: 7, groupSize: 5, crossed: 2 },
  pictograph: { kind: "pictograph", title: "Books read", keyEmoji: "📘", keyEach: 2,
    rows: [{ label: "Mon", count: 3 }, { label: "Tue", count: 5 }] },
  thermometer: { kind: "thermometer", min: 0, max: 100, value: 37, tempUnit: "C" },
};

test("LIMITS, EMOJI_DENY, kinds, hosts, keys and edges match the server module", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(V.VIS_LIMITS)), JSON.parse(JSON.stringify(server.LIMITS)));
  assert.deepEqual(V.EMOJI_DENY, Array.from(server.EMOJI_DENY));
  assert.deepEqual(V.VIS_KINDS, Array.from(server.KINDS));
  assert.deepEqual(JSON.parse(JSON.stringify(V.VIS_HOSTS)), JSON.parse(JSON.stringify(server.HOSTS)));
  assert.deepEqual(JSON.parse(JSON.stringify(V.VIS_KEYS)), JSON.parse(JSON.stringify(server.KEYS)));
  assert.deepEqual(JSON.parse(JSON.stringify(V.VIS_EDGES)), JSON.parse(JSON.stringify(server.EDGES)));
});

test("client sanitizer agrees with the server validator on good and bad fixtures", () => {
  const bad = [
    null, "x", 5, [], {}, { kind: "nope" }, { kind: "pie", parts: 1, shaded: 0, theme: "pizza" },
    { kind: "pie", parts: 8, shaded: 9, theme: "pizza" }, { kind: "pie", parts: 8, shaded: 3, theme: "cake" },
    { kind: "pie", parts: 8.5, shaded: 3, theme: "pizza" }, { kind: "pie", parts: NaN, shaded: 0, theme: "pizza" },
    { kind: "pie", parts: Infinity, shaded: 0, theme: "pizza" }, { kind: "pie", parts: "8", shaded: 3, theme: "pizza" },
    { kind: "pie", parts: 8, shaded: 3, theme: "pizza", extra: 1 },
    { kind: "barChart", bars: [{ label: "A", value: 1 }] },
    { kind: "barChart", bars: [{ label: "A", value: 1 }, { label: "a", value: 2 }] },
    { kind: "barChart", bars: [{ label: "A", value: 101 }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: [{ label: "A", value: -1 }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: [{ label: "<b>A</b>", value: 1 }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: [{ label: "http://x.io", value: 1 }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: [{ label: "A", value: 1, emoji: "🔫" }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: [{ label: "A".repeat(15), value: 1 }, { label: "B", value: 2 }] },
    { kind: "barChart", bars: Array.from({ length: 9 }, (_, i) => ({ label: "L" + i, value: i })) },
    { kind: "numberLine", min: 0, max: 21, step: 2 }, { kind: "numberLine", min: 5, max: 5, step: 1 },
    { kind: "numberLine", min: 0, max: 20, step: 2, marks: [3] }, { kind: "numberLine", min: 0, max: 1000, step: 1 },
    { kind: "clock", hour: 0, minute: 0 }, { kind: "clock", hour: 12, minute: 60 },
    { kind: "shape", shape: "square", sideLabels: [1, 2, 1, 2], lengthUnit: "cm" },
    { kind: "shape", shape: "triangle", sideLabels: [3, 4], lengthUnit: "cm" },
    { kind: "shape", shape: "triangle", splitParts: 2, splitShaded: 1 },
    { kind: "emojiGroup", emoji: "abc", count: 3 }, { kind: "emojiGroup", emoji: "🍎", count: 31 },
    { kind: "emojiGroup", emoji: "🍎", count: 3, crossed: 4 },
    { kind: "pictograph", keyEmoji: "📘", keyEach: 2, rows: [{ label: "A", count: 11 }, { label: "B", count: 1 }] },
    { kind: "thermometer", min: 0, max: 200, value: 5, tempUnit: "C" }, { kind: "thermometer", min: 0, max: 100, value: 5, tempUnit: "K" },
    JSON.parse('{"kind":"pie","parts":4,"shaded":1,"theme":"pizza","__proto__":{"x":1}}'),
    JSON.parse('{"kind":"pie","parts":4,"shaded":1,"theme":"pizza","constructor":null}'),
  ];
  const mixed = Object.assign({}, GOOD.pie, { bars: null, title: null }); // other kinds' keys as null are tolerated
  const goods = Object.values(GOOD).concat([mixed]);
  for (const g of goods) {
    const s = server.validateVisual(g, { host: "question", allowedKinds: server.KINDS });
    const c = V.sanitizeVisual(g, "question");
    assert.equal(s.ok, true, JSON.stringify(g));
    assert.deepEqual(c, s.value);
  }
  for (const b of bad) {
    const s = server.validateVisual(b, { host: "question", allowedKinds: server.KINDS });
    assert.equal(s.ok, false, "server accepted " + JSON.stringify(b));
    assert.equal(V.sanitizeVisual(b, "question"), null, "client accepted " + JSON.stringify(b));
    assert.equal(V.renderVisual(b), null);
  }
});

test("compact hosts reject barChart, numberLine and pictograph on the client", () => {
  for (const host of ["memory", "sequence", "sort"]) {
    assert.equal(V.sanitizeVisual(GOOD.barChart, host), null);
    assert.equal(V.sanitizeVisual(GOOD.numberLine, host), null);
    assert.equal(V.sanitizeVisual(GOOD.pictograph, host), null);
    assert.notEqual(V.sanitizeVisual(GOOD.pie, host), null);
  }
  assert.equal(V.sanitizeVisual(GOOD.pie, "bogus"), null);
});

test("sanitizeVisual returns a fresh object", () => {
  const out = V.sanitizeVisual(GOOD.barChart, "question");
  assert.notEqual(out, GOOD.barChart);
  assert.notEqual(out.bars[0], GOOD.barChart.bars[0]);
});

test("barChart: one rect per bar, proportional heights, values and aria text", () => {
  const svg = V.renderVisual(GOOD.barChart, { maxWidth: 300 });
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.getAttribute("viewBox"), "0 0 360 250");
  assert.equal(svg.getAttribute("aria-label"), "Bar chart (Pets in class): Dogs 5, Cats 3, Fish 8");
  assert.equal(svg.querySelector("title").textContent, svg.getAttribute("aria-label"));
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.equal(svg.style.maxWidth, "300px");
  const bars = all(svg, ".mqv-bar");
  assert.equal(bars.length, 3);
  const h = bars.map((b) => Number(b.getAttribute("height")));
  assert.ok(Math.abs(h[0] / h[1] - 5 / 3) < 0.01 && Math.abs(h[2] / h[1] - 8 / 3) < 0.01);
  assert.deepEqual(text(svg, ".mqv-value"), ["5", "3", "8"]);
  assert.deepEqual(text(svg, ".mqv-label"), ["Dogs", "Cats", "Fish"]);
  assert.ok(text(svg, "text").includes("Pets in class") && text(svg, "text").includes("Pets") && text(svg, "text").includes("🐶"));
  assert.ok(all(svg, ".mqv-grid").length >= 2);
});

test("barChart: showValues false hides value labels but the description keeps values", () => {
  const svg = V.renderVisual(Object.assign({}, GOOD.barChart, { showValues: false }));
  assert.equal(all(svg, ".mqv-value").length, 0);
  assert.match(svg.getAttribute("aria-label"), /Dogs 5/);
});

test("barChart: 8 bars and value 100 still render; zero value gives an empty bar", () => {
  const eight = { kind: "barChart", bars: Array.from({ length: 8 }, (_, i) => ({ label: "Longer name " + i, value: i === 0 ? 0 : i * 14 })) };
  const svg = V.renderVisual(eight);
  assert.equal(all(svg, ".mqv-bar").length, 8);
  assert.equal(all(svg, ".mqv-bar")[0].getAttribute("height"), "0");
  assert.ok(all(svg, ".mqv-label").some((n) => /rotate/.test(n.getAttribute("transform") || "")));
});

test("pie: pizza has toppings on shaded slices only and dashed unshaded slices", () => {
  const svg = V.renderVisual(GOOD.pie);
  assert.equal(svg.getAttribute("aria-label"), "Pizza cut into 8 equal slices, 3 shaded");
  assert.equal(all(svg, ".mqv-slice").length, 8);
  assert.equal(all(svg, ".mqv-on").length, 3);
  const off = all(svg, ".mqv-off");
  assert.equal(off.length, 5);
  assert.ok(off.every((p) => p.getAttribute("stroke-dasharray")));
  assert.equal(all(svg, ".mqv-topping").length, 12);
  assert.equal(all(svg, ".mqv-on").some((p) => p.getAttribute("stroke-dasharray")), false);
});

test("pie: 0 shaded, all shaded, and every theme", () => {
  assert.equal(all(V.renderVisual({ kind: "pie", parts: 4, shaded: 0, theme: "pizza" }), ".mqv-topping").length, 0);
  const full = V.renderVisual({ kind: "pie", parts: 12, shaded: 12, theme: "pizza" });
  assert.equal(all(full, ".mqv-off").length, 0);
  assert.equal(all(full, ".mqv-on").length, 12);
  for (const theme of ["pizza", "pie", "chocolate", "plain"]) {
    const svg = V.renderVisual({ kind: "pie", parts: 5, shaded: 2, theme });
    assert.equal(all(svg, ".mqv-slice").length, 5, theme);
    assert.ok(svg.getAttribute("aria-label").endsWith("2 shaded"));
  }
  assert.match(V.renderVisual({ kind: "pie", parts: 6, shaded: 1, theme: "chocolate" }).getAttribute("aria-label"), /^Chocolate cookie cut into 6 equal pieces/);
  assert.equal(all(V.renderVisual({ kind: "pie", parts: 2, shaded: 1, theme: "plain" }), ".mqv-topping").length, 0);
});

test("numberLine: ticks every step, marks drawn, labels capped", () => {
  const svg = V.renderVisual(GOOD.numberLine);
  assert.equal(svg.getAttribute("aria-label"), "Number line from 0 to 20, counting by 2, marked at 6, 14");
  assert.equal(all(svg, ".mqv-tick").length, 11);
  assert.equal(all(svg, ".mqv-mark").length, 2);
  assert.ok(all(svg, ".mqv-tick-label").length <= 11);
  const dense = V.renderVisual({ kind: "numberLine", min: 0, max: 20, step: 1 });
  assert.equal(all(dense, ".mqv-tick").length, 21);
  assert.ok(all(dense, ".mqv-tick-label").length <= 11);
  assert.equal(all(V.renderVisual({ kind: "numberLine", min: -10, max: 10, step: 5 }), ".mqv-mark").length, 0);
});

test("clock: hand angles and aria text", () => {
  const svg = V.renderVisual(GOOD.clock);
  assert.equal(svg.getAttribute("aria-label"), "Clock showing 3:30");
  assert.equal(svg.querySelector(".mqv-hour").getAttribute("data-angle"), "105");
  assert.equal(svg.querySelector(".mqv-minute").getAttribute("data-angle"), "180");
  assert.equal(all(svg, ".mqv-tick").length, 60);
  assert.equal(text(svg, ".mqv-digital")[0], "3:30");
  const noon = V.renderVisual({ kind: "clock", hour: 12, minute: 5 });
  assert.equal(noon.getAttribute("aria-label"), "Clock showing 12:05");
  assert.equal(noon.querySelector(".mqv-hour").getAttribute("data-angle"), "2.5");
  assert.equal(noon.querySelector(".mqv-digital"), null);
});

test("shape: outline, side labels with unit, and split parts", () => {
  const svg = V.renderVisual(GOOD.shape);
  assert.equal(svg.getAttribute("aria-label"), "Rectangle with sides 6 cm, 4 cm, 6 cm, 4 cm, cut into 4 equal parts, 1 shaded");
  assert.deepEqual(text(svg, ".mqv-side"), ["6 cm", "4 cm", "6 cm", "4 cm"]);
  assert.equal(all(svg, ".mqv-part").length, 4);
  assert.equal(all(svg, ".mqv-on").length, 1);
  assert.ok(svg.querySelector("polygon.mqv-outline"));
  const circle = V.renderVisual({ kind: "shape", shape: "circle", splitParts: 8, splitShaded: 3 });
  assert.equal(all(circle, "path.mqv-part").length, 8);
  assert.ok(circle.querySelector("circle.mqv-outline"));
  const hex = V.renderVisual({ kind: "shape", shape: "hexagon", sideLabels: [2, 2, 2, 2, 2, 2], lengthUnit: "none" });
  assert.deepEqual(text(hex, ".mqv-side"), ["2", "2", "2", "2", "2", "2"]);
  assert.equal(all(hex, "polygon.mqv-outline")[0].getAttribute("points").split(" ").length, 6);
  for (const s of ["triangle", "square", "pentagon", "circle"]) assert.ok(V.renderVisual({ kind: "shape", shape: s }), s);
});

test("emojiGroup: one symbol per item, group rings, crossed marks", () => {
  const svg = V.renderVisual(GOOD.emojiGroup);
  assert.equal(svg.getAttribute("aria-label"), "7 🍎 in groups of 5, 2 crossed out");
  assert.equal(all(svg, ".mqv-sym").length, 7);
  assert.ok(text(svg, ".mqv-sym").every((t) => t === "🍎"));
  assert.equal(all(svg, ".mqv-ring").length, 2);
  assert.equal(all(svg, ".mqv-cross").length, 4);
  const plain = V.renderVisual({ kind: "emojiGroup", emoji: "⭐", count: 30 });
  assert.equal(all(plain, ".mqv-sym").length, 30);
  assert.equal(all(plain, ".mqv-ring").length, 0);
  const ones = V.renderVisual({ kind: "emojiGroup", emoji: "⭐", count: 30, groupSize: 1 });
  assert.equal(all(ones, ".mqv-ring").length, 30);
});

test("pictograph: symbols per row, key box, aria text", () => {
  const svg = V.renderVisual(GOOD.pictograph);
  assert.equal(svg.getAttribute("aria-label"), "Pictograph (Books read), each 📘 stands for 2: Mon 3 symbols, Tue 5 symbols");
  assert.equal(all(svg, ".mqv-sym").length, 8);
  assert.deepEqual(text(svg, ".mqv-key"), ["📘 = 2"]);
  assert.deepEqual(text(svg, ".mqv-label"), ["Mon", "Tue"]);
  const one = V.renderVisual({ kind: "pictograph", keyEmoji: "🌟", keyEach: 1, rows: [{ label: "A", count: 1 }, { label: "B", count: 0 }] });
  assert.match(one.getAttribute("aria-label"), /A 1 symbol, B 0 symbols/);
});

test("thermometer: mercury height follows the value; ticks and unit", () => {
  const svg = V.renderVisual(GOOD.thermometer);
  assert.equal(svg.getAttribute("aria-label"), "Thermometer reading 37 degrees C, scale 0 to 100");
  const col = all(svg, "rect.mqv-mercury")[0];
  assert.equal(col.getAttribute("y"), "140.8"); // 200 - 0.37 * 160
  assert.equal(all(svg, ".mqv-tick").length, 11);
  assert.ok(text(svg, "text").includes("°C"));
  const low = V.renderVisual({ kind: "thermometer", min: -10, max: 30, value: -10, tempUnit: "F" });
  assert.equal(all(low, "rect.mqv-mercury")[0].getAttribute("y"), "200");
  assert.equal(all(low, ".mqv-tick").length, 9);
});

test("malformed input returns null and never throws", () => {
  const nasty = [undefined, null, 0, "", "<svg onload=alert(1)>", [], [1], {}, () => 1, Symbol("x"), { kind: ["pie"] },
    { kind: "pie", parts: {}, shaded: [], theme: {} },
    new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } }),
    { get kind() { throw new Error("boom"); } },
    { kind: "barChart", bars: { length: 3 } },
    { kind: "barChart", bars: [null, null] },
    { kind: "pictograph", keyEmoji: "📘", keyEach: 1, rows: [{ label: "A", count: 1 }, 5] },
  ];
  for (const n of nasty) {
    assert.doesNotThrow(() => V.renderVisual(n));
    assert.equal(V.renderVisual(n), null);
    assert.doesNotThrow(() => V.describeVisual(n));
    assert.equal(V.describeVisual(n), "");
  }
});

test("a drawing bug is caught: renderVisual returns null and warns without model text", () => {
  const doc = dom.window.document;
  const orig = doc.createElementNS;
  warn.length = 0;
  doc.createElementNS = () => { throw new Error("secret model text"); };
  try { assert.equal(V.renderVisual(GOOD.pie), null); } finally { doc.createElementNS = orig; }
  assert.deepEqual(warn, ["visual render failed"]);
});

test("hostile strings are rejected, and odd-but-legal labels stay text nodes only", () => {
  const hostile = ["<img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "javascript:alert(1)", "https://evil.example/x",
    "www.evil.com", "evil.com", "data:text/html,hi", "a&b", "x\"y", "a`b", "{{x}}", "a\u202Eb", "a\nb", "a\u0000b", "Tom@x.io"];
  for (const label of hostile) {
    const def = { kind: "barChart", title: label, bars: [{ label: "A", value: 1 }, { label: "B", value: 2 }] };
    assert.equal(V.renderVisual(def), null, label);
    const bar = { kind: "barChart", bars: [{ label, value: 1 }, { label: "B", value: 2 }] };
    assert.equal(V.renderVisual(bar), null, label);
    const pic = { kind: "pictograph", keyEmoji: "📘", keyEach: 1, rows: [{ label, count: 1 }, { label: "B", count: 2 }] };
    assert.equal(V.renderVisual(pic), null, label);
  }
  assert.equal(V.renderVisual({ kind: "emojiGroup", emoji: "<b>", count: 2 }), null);
  assert.equal(V.renderVisual({ kind: "emojiGroup", emoji: "🍎<", count: 2 }), null);
  const odd = { kind: "barChart", title: "Fish 'n' chips: 50% off", bars: [{ label: "A/B", value: 1 }, { label: "C.D", value: 2 }] };
  const svg = V.renderVisual(odd);
  assert.ok(svg);
  assert.ok(text(svg, "text").includes("Fish 'n' chips: 50% off"));
  for (const t of all(svg, "text")) assert.deepEqual(Array.from(t.childNodes).map((n) => n.nodeType), t.childNodes.length ? [3] : []);
});

test("rendered trees have no forbidden elements or attributes for every kind and host", () => {
  const bannedTags = new Set(["script", "foreignobject", "a", "image", "use", "style", "iframe", "animate", "set"]);
  const trees = [];
  for (const g of Object.values(GOOD)) trees.push(V.renderVisual(g));
  trees.push(V.renderVisual({ kind: "pie", parts: 12, shaded: 12, theme: "chocolate" }, { host: "memory" }));
  for (const svg of trees) {
    assert.ok(svg);
    for (const node of [svg].concat(all(svg, "*"))) {
      assert.equal(bannedTags.has(node.localName.toLowerCase()), false, node.localName);
      for (const a of Array.from(node.attributes)) {
        assert.equal(/^on/i.test(a.name), false, a.name);
        assert.equal(/href/i.test(a.name), false, a.name);
        assert.equal(/javascript:|<|>/i.test(a.value), false, a.name + "=" + a.value);
      }
    }
    assert.ok(all(svg, "*").length <= 130, "node cap");
  }
});

test("worst-case node counts stay bounded", () => {
  const big = [
    { kind: "pictograph", keyEmoji: "📘", keyEach: 1, rows: [1, 2, 3, 4].map((i) => ({ label: "R" + i, count: 10 })) },
    { kind: "emojiGroup", emoji: "⭐", count: 30, groupSize: 1, crossed: 30 },
    { kind: "pie", parts: 12, shaded: 12, theme: "pizza" },
    { kind: "numberLine", min: 0, max: 20, step: 1, marks: [1, 2, 3] },
    { kind: "barChart", bars: Array.from({ length: 8 }, (_, i) => ({ label: "L" + i, value: 100, emoji: "🍎" })) },
  ];
  for (const b of big) {
    const n = all(V.renderVisual(b), "*").length;
    assert.ok(n <= 130, b.kind + " " + n);
  }
});

test("region source never uses innerHTML, style strings from data, href or inline handlers", () => {
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|DOMParser/.test(CODE), false);
  assert.equal(/\bhref\b|xlink|onload|onclick|onerror/i.test(CODE), false);
  assert.equal(/setAttribute\("style"|\.style\.cssText|\.style\s*=/.test(REGION), false);
});

test("reduced motion: bar animation lives only inside prefers-reduced-motion: no-preference", () => {
  const css = INDEX.slice(INDEX.indexOf("<style>"), INDEX.indexOf("</style>"));
  const at = css.indexOf("@keyframes mqvGrow");
  assert.ok(at > 0);
  const media = css.lastIndexOf("@media", at);
  assert.match(css.slice(media, media + 60), /prefers-reduced-motion: no-preference/);
  assert.equal(/animation:[^;]*mqvGrow/.test(css.slice(0, media)), false);
});

test("adaptGame keeps a valid per-question visual and drops questions whose visual fails", () => {
  const src = INDEX.slice(INDEX.indexOf("const COPY = {"), INDEX.indexOf("function startCustomGame("));
  const { adaptGame } = new Function("document", "console", REGION + "\n" + src + "\nreturn { adaptGame };")(dom.window.document, console);
  const q = (extra) => Object.assign({ text: "Which is biggest?", options: ["A", "B", "C"], correctIndex: 1 }, extra);
  const def = (qs) => ({ id: "g1", title: "T", topic: "graphs", subject: "math", questions: qs });
  const g = adaptGame(def([q({ visual: GOOD.pie }), q(), q(), q({ visual: { kind: "pie", parts: 1, shaded: 0, theme: "pizza" } }), q({ visual: null })]));
  assert.equal(g.questions.length, 3);
  assert.deepEqual(g.questions[0].visual, server.validateVisual(GOOD.pie, { host: "question", allowedKinds: server.KINDS }).value);
  assert.equal(g.questions[1].visual, null);
  assert.equal(adaptGame(def([q({ visual: GOOD.pie }), q({ visual: { kind: "bad" } }), q({ visual: "<svg>" }), q()])), null);
  assert.equal(adaptGame(def([q(), q(), q()])).questions.length, 3);
});

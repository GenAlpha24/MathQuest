"use strict";
// Scripted stand-in for the Vertex wrapper, same interface. Used only by the emulator e2e run
// (index.js guard). Steered by plain trigger words in the prompt:
//   mockinvalidonce  generate returns bad JSON until the handler retries with "fixes"
//   mockinvalidtwice generate always returns bad JSON
//   mockblocked      classify reports a safety block
//   mockoffTopic     classify says the request is off topic
// Template (classify): mockmemory mocksequence mocksort mockcatch mockpicture mockquiz (none = quiz)
// Pictures (classify, up to 2): mockbar mockpie mockline mockclock mockshape mockemoji mockpicto mockthermo
// Failure injections (generate; bad* and mismatch are invalid on the first attempt and fixed on the retry):
//   mockbadvisual  mockmismatch  mockdupcards  mockbadsort
//   mockschema400  generate throws {status:400} while pictures are requested, then works text-only
//   mockfallback   classify says only quiz and picturequiz fit

const ok = (text) => ({ text, blocked: false, blockReason: null, finishReason: "STOP", inTokens: 10, outTokens: 10 });

const TEMPLATE_WORDS = [["mockmemory", "memory"], ["mocksequence", "sequence"], ["mocksort", "sort"], ["mockcatch", "catch"], ["mockpicture", "picturequiz"], ["mockquiz", "quiz"]];
const KIND_WORDS = [["mockbar", "barChart"], ["mockpie", "pie"], ["mockline", "numberLine"], ["mockclock", "clock"], ["mockshape", "shape"], ["mockemoji", "emojiGroup"], ["mockpicto", "pictograph"], ["mockthermo", "thermometer"]];

function classifyResponse(payload) {
  const prompt = String(payload.request || "");
  const lower = prompt.toLowerCase();
  if (lower.includes("mockblocked")) {
    return { text: "", blocked: true, blockReason: "SAFETY", finishReason: null, inTokens: 10, outTokens: 0 };
  }
  const off = lower.includes("mockofftopic");
  const topic = prompt.replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 60) || "numbers";
  let template = (TEMPLATE_WORDS.find(([w]) => lower.includes(w)) || [null, "quiz"])[1];
  let fits = [...new Set([template, "quiz", "picturequiz"])];
  if (lower.includes("mockfallback")) { template = "quiz"; fits = ["quiz", "picturequiz"]; }
  const visualKinds = KIND_WORDS.filter(([w]) => lower.includes(w)).map(([, k]) => k).slice(0, 2);
  return ok(JSON.stringify({
    isSteam: !off,
    safe: true,
    refusalReason: off ? "off_topic" : "none",
    subject: "Science",
    topic: off ? "none" : topic,
    theme: null,
    grade: payload.gradeHint,
    difficulty: "easy",
    template: off ? "quiz" : template,
    fits: off ? ["quiz"] : fits,
    visualKinds: off ? [] : visualKinds,
  }));
}

function buildQuestions(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ci = i % 3;
    const options = [String(i + 20), String(i + 30), String(i + 40)];
    options[ci] = String(i + 2);
    out.push({
      text: "Which number comes after " + (i + 1) + "?",
      options,
      correctIndex: ci,
      hint: "Count up by one.",
      explanation: "Counting up one more gives the next number.",
      emoji: null,
    });
  }
  return out;
}

// Correct answer goes at position ci (mod length); wrong ones fill the rest in order.
function place(correct, wrongs, ci) {
  const at = ci % (wrongs.length + 1);
  const options = wrongs.slice();
  options.splice(at, 0, correct);
  return { options, correctIndex: at };
}

// One valid compact picture per kind (usable on questions and on memory, sequence and sort items).
function compactVisual(kind, i) {
  switch (kind) {
    case "pie": return { kind: "pie", parts: 8, shaded: 1 + (i % 5), theme: "pizza" };
    case "emojiGroup": return { kind: "emojiGroup", emoji: "🍎", count: 3 + (i % 5) };
    case "clock": return { kind: "clock", hour: 1 + (i % 12), minute: i % 2 ? 30 : 0 };
    case "shape": return { kind: "shape", shape: "triangle" };
    case "thermometer": return { kind: "thermometer", min: 0, max: 100, value: 20 + 5 * (i % 10), tempUnit: "C" };
    default: return null;
  }
}

const COMPACT = ["pie", "emojiGroup", "clock", "shape", "thermometer"];

// Question about a picture, with a machine-checkable answerCheck. Texts are unique per index.
function pictureQuestion(kind, i) {
  const hint = "Look at the picture.";
  const base = { hint, explanation: "The picture shows the answer.", emoji: null };
  const pre = "Game " + (i + 1) + ": ";
  let text, visual, answerCheck, right, wrongs;
  switch (kind) {
    case "barChart": {
      const names = ["Apples", "Pears", "Plums"];
      visual = { kind, title: "Fruit we picked", yLabel: "Number", showValues: false, bars: [{ label: "Apples", value: 9 }, { label: "Pears", value: 6 }, { label: "Plums", value: 4 }] };
      text = pre + "Which fruit has the tallest bar?"; answerCheck = { op: "maxLabel", label: null, label2: null };
      right = names[0]; wrongs = names.slice(1);
      break;
    }
    case "pie": {
      const s = 1 + (i % 5);
      visual = { kind, parts: 8, shaded: s, theme: "pizza" };
      text = pre + "How much of the pizza is shaded?"; answerCheck = { op: "shadedFraction", label: null, label2: null };
      right = s + "/8"; wrongs = [(s + 1) + "/8", s + "/9"];
      break;
    }
    case "numberLine": {
      const m = 6 + 2 * (i % 5);
      visual = { kind, min: 0, max: 20, step: 2, marks: [m] };
      text = pre + "What number does the dot show?"; answerCheck = { op: "markValue", label: null, label2: null };
      right = String(m); wrongs = [String(m + 2), String(m - 2)];
      break;
    }
    case "clock": {
      const h = 1 + (i % 12), mm = i % 2 ? "30" : "00";
      visual = { kind, hour: h, minute: Number(mm) };
      text = pre + "What time does the clock show?"; answerCheck = { op: "time", label: null, label2: null };
      right = h + ":" + mm; wrongs = [((h % 12) + 1) + ":" + mm, h + ":" + (mm === "30" ? "00" : "30")];
      break;
    }
    case "shape": {
      const a = 3 + (i % 4);
      visual = { kind, shape: "rectangle", sideLabels: [a, 2, a, 2], lengthUnit: "cm" };
      text = pre + "What is the distance around the rectangle?"; answerCheck = { op: "perimeter", label: null, label2: null };
      right = (2 * a + 4) + " cm"; wrongs = [(a + 2) + " cm", (a * 2) + " cm"];
      break;
    }
    case "emojiGroup": {
      const c = 6 + (i % 4);
      visual = { kind, emoji: "🍎", count: c, crossed: 2 };
      text = pre + "How many apples are left?"; answerCheck = { op: "remaining", label: null, label2: null };
      right = String(c - 2); wrongs = [String(c), String(c - 1)];
      break;
    }
    case "pictograph": {
      visual = { kind, title: "Books read", keyEmoji: "📘", keyEach: 2, rows: [{ label: "Mon", count: 3 }, { label: "Tue", count: 5 }, { label: "Wed", count: 2 }] };
      text = pre + "How many books did we read on Tue?"; answerCheck = { op: "valueOf", label: "Tue", label2: null };
      right = "10"; wrongs = ["5", "8"];
      break;
    }
    default: {
      const v = 20 + 5 * (i % 10);
      visual = { kind: "thermometer", min: 0, max: 100, value: v, tempUnit: "C" };
      text = pre + "What does the thermometer read?"; answerCheck = { op: "reading", label: null, label2: null };
      right = String(v); wrongs = [String(v + 10), String(v - 10)];
    }
  }
  const p = place(right, wrongs, i);
  return { text, options: p.options, correctIndex: p.correctIndex, ...base, visual, answerCheck };
}

// With no pictures on offer the data is written into the question text itself.
function inlineQuestion(i) {
  const p = place("Dogs", ["Cats", "Fish"], i);
  return {
    text: "Game " + (i + 1) + ": Cats have 6. Dogs have 9. Fish have 4. Which has the most?",
    options: p.options, correctIndex: p.correctIndex, hint: "Compare the numbers.", explanation: "Nine is the biggest number.", emoji: null,
  };
}

function choiceGame(payload, kinds, topic, fixed) {
  const n = payload.questionCount;
  let questions;
  if (kinds.length) questions = Array.from({ length: n }, (_, i) => pictureQuestion(kinds[i % kinds.length], i));
  else if (topic.includes("mockpicture") || topic.includes("mockbar") || topic.includes("mockpie")) questions = Array.from({ length: n }, (_, i) => inlineQuestion(i));
  else questions = buildQuestions(n);
  if (!fixed && kinds.length && topic.includes("mockbadvisual")) {
    const v = questions[0].visual;
    if (v.kind === "pie") v.shaded = v.parts + 1; else v.bogus = 5;
  }
  if (!fixed && kinds.length && topic.includes("mockmismatch")) {
    const q = questions[0];
    q.correctIndex = (q.correctIndex + 1) % q.options.length;
  }
  return { stayedOnSteamTopic: true, title: kinds.length ? "Picture Quiz Fun" : "Fun Number Quiz", questions };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const WORDS = ["One", "Two", "Three", "Four", "Five", "Six"];

function memoryGame(payload, kinds, topic, fixed) {
  const n = clamp(payload.itemCount || 5, 4, 6);
  const vk = kinds.find((k) => COMPACT.includes(k));
  const pairs = Array.from({ length: n }, (_, i) => ({
    a: { label: String(i + 1) },
    b: { label: WORDS[i], ...(vk ? { visual: compactVisual(vk, i) } : {}) },
    hint: "Count with your fingers.", explanation: "The number and its word match.",
  }));
  if (!fixed && topic.includes("mockdupcards")) pairs[1].a.label = pairs[0].a.label;
  return { stayedOnSteamTopic: true, title: "Number Pairs", pairs };
}

function sequenceGame(payload, kinds) {
  const n = clamp(payload.itemCount || 4, 3, 5);
  const vk = kinds.find((k) => COMPACT.includes(k));
  const rounds = Array.from({ length: n }, (_, i) => ({
    prompt: "Put the plant steps in order, set " + (i + 1),
    steps: ["Seed is planted", "Seed sprouts", "Plant grows", "Flower blooms"].map((label, j) => ({
      label, emoji: null, ...(vk && j === 0 ? { visual: compactVisual(vk, i) } : {}),
    })),
    hint: "What happens first?", explanation: "A plant starts as a seed and grows up.",
  }));
  return { stayedOnSteamTopic: true, title: "Plant Order", rounds };
}

const ITEMS = ["Ice cube", "Water", "Rock", "Milk", "Wood block", "Juice", "Toy brick", "Soup", "Metal spoon", "Syrup", "Coin", "Tea"];
function sortGame(payload, kinds, topic, fixed) {
  const n = clamp(payload.itemCount || 10, 8, 12);
  const vk = kinds.find((k) => COMPACT.includes(k));
  const bad = !fixed && topic.includes("mockbadsort");
  const items = Array.from({ length: n }, (_, i) => ({
    label: ITEMS[i], emoji: null, bin: bad ? 0 : i % 2,
    explanation: i % 2 ? "It flows, so it is a liquid." : "It keeps its shape, so it is a solid.",
    ...(vk && i === 0 ? { visual: compactVisual(vk, i) } : {}),
  }));
  return {
    stayedOnSteamTopic: true, title: "Solid or Liquid",
    bins: [{ label: "Solid", emoji: "🧊", rule: "Keeps its own shape" }, { label: "Liquid", emoji: "💧", rule: "Flows and takes a shape" }],
    items,
  };
}

function generateResponse(payload) {
  const topic = String(payload.topic || "").toLowerCase();
  const fixed = Array.isArray(payload.fixes) && payload.fixes.length > 0;
  if (topic.includes("mockinvalidtwice") || (topic.includes("mockinvalidonce") && !fixed)) return ok("not json");
  const kinds = Array.isArray(payload.visualKinds) ? payload.visualKinds : [];
  if (topic.includes("mockschema400") && kinds.length) {
    const e = new Error("schema rejected");
    e.status = 400;
    throw e;
  }
  const template = payload.template || "quiz";
  let game;
  if (template === "memory") game = memoryGame(payload, kinds, topic, fixed);
  else if (template === "sequence") game = sequenceGame(payload, kinds);
  else if (template === "sort") game = sortGame(payload, kinds, topic, fixed);
  else game = choiceGame(payload, kinds, topic, fixed);
  return ok(JSON.stringify(game));
}

function create() {
  return {
    async classify(req) { return classifyResponse(JSON.parse(req.userText)); },
    async generate(req) { return generateResponse(JSON.parse(req.userText)); },
  };
}

module.exports = { create };

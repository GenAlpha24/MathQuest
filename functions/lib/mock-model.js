"use strict";
// Scripted stand-in for the Vertex wrapper, same interface. Used only by the emulator e2e run
// (index.js guard). Steered by plain trigger words in the prompt:
//   mockinvalidonce  generate returns bad JSON until the handler retries with "fixes"
//   mockinvalidtwice generate always returns bad JSON
//   mockblocked      classify reports a safety block
//   mockoffTopic     classify says the request is off topic

const ok = (text) => ({ text, blocked: false, blockReason: null, finishReason: "STOP", inTokens: 10, outTokens: 10 });

function classifyResponse(payload) {
  const prompt = String(payload.request || "");
  const lower = prompt.toLowerCase();
  if (lower.includes("mockblocked")) {
    return { text: "", blocked: true, blockReason: "SAFETY", finishReason: null, inTokens: 10, outTokens: 0 };
  }
  const off = lower.includes("mockofftopic");
  const topic = prompt.replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 60) || "numbers";
  return ok(JSON.stringify({
    isSteam: !off,
    safe: true,
    refusalReason: off ? "off_topic" : "none",
    subject: "Science",
    topic: off ? "none" : topic,
    theme: null,
    grade: payload.gradeHint,
    difficulty: "easy",
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

function generateResponse(payload) {
  const topic = String(payload.topic || "").toLowerCase();
  const fixed = Array.isArray(payload.fixes) && payload.fixes.length > 0;
  if (topic.includes("mockinvalidtwice") || (topic.includes("mockinvalidonce") && !fixed)) return ok("not json");
  return ok(JSON.stringify({ stayedOnSteamTopic: true, title: "Fun Number Quiz", questions: buildQuestions(payload.questionCount) }));
}

function create() {
  return {
    async classify(req) { return classifyResponse(JSON.parse(req.userText)); },
    async generate(req) { return generateResponse(JSON.parse(req.userText)); },
  };
}

module.exports = { create };

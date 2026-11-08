"use strict";
// Shared text-safety and reading-level helpers for untrusted model strings. Pure; no model text in results.

const { containsBanned, hasUrl } = require("./prefilter");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cpLen = (s) => Array.from(s).length;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const FORBIDDEN_CHARS_RE = /[<>`{}[\]|\\*]/;
const HIDDEN_CHARS_RE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const REFUSAL_MARKER_RE = /\bas an ai\b|\bi cannot\b|\bi can't\b|\bi can’t\b|\bi'm sorry\b|\bi’m sorry\b|\blanguage model\b/i;
const EMOJI_RE = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*$/u;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const HANDLE_RE = /(?:^|[\s(])@\w+/;
const PHONE_RE = /(?<!\d)\d{10,15}(?!\d)|(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;

// Reading level (see design 4.3 rule 6). Per question text: words (numbers/units excluded),
// words in the longest sentence, and vocabulary difficulty; per option: words only.
// Common STEAM terms (REL_ALLOW) never count as "hard" words, and a single hard word never fails a question.
const READING = [
  { max: 0, total: 12, sentence: 12, opt: 4, avg: 6.5, longRatio: 0.15 },
  { max: 1, total: 22, sentence: 15, opt: 6, avg: 6.5, longRatio: 0.2 },
  { max: 2, total: 28, sentence: 18, opt: 7, avg: 6.5, longRatio: 0.2 },
  { max: 3, total: 42, sentence: 24, opt: 10, avg: 7, longRatio: 0.25 },
  { max: 4, total: 48, sentence: 28, opt: 11, avg: 7.5, longRatio: 0.3 },
  { max: 5, total: 54, sentence: 30, opt: 12, avg: 7.5, longRatio: 0.3 },
];
const LONG_WORD_LEN = 9;
const REL_ALLOW = new Set((
  "graph axis category frequency compare comparison measure measurement estimate equation fraction numerator denominator " +
  "triangle rectangle pentagon hexagon octagon perimeter area volume symmetry pattern sequence multiplication addition " +
  "subtraction division temperature thermometer planet gravity electricity magnet magnetic habitat ecosystem " +
  "photosynthesis evaporation condensation precipitation solar energy engineer engineering technology computer " +
  "algorithm program robot vertical horizontal tally pictograph data scale bridge triangle diameter circumference " +
  "rotation reflection rhombus parallelogram quadrilateral predator vitamin mineral molecule material insect " +
  "butterfly dinosaur volcano earthquake telescope microscope experiment observation prediction population " +
  "environment recycle absorb reflect orbit galaxy rainbow vibration instrument rhythm melody pattern symmetrical"
).split(/\s+/));
const readingFor = (grade) => READING.find((r) => grade <= r.max) || READING[READING.length - 1];
// Alphabetic words only; numbers, units glued to numbers and symbols are ignored.
const letterWords = (s) => s.match(/\p{L}[\p{L}'’-]*/gu) || [];
const isAllowed = (w) => {
  const k = w.toLowerCase().replace(/['’-]/g, "");
  return REL_ALLOW.has(k) || REL_ALLOW.has(k.replace(/(?:es|s)$/, ""));
};
function textTooHard(text, rl) {
  const words = letterWords(text);
  if (words.length > rl.total) return true;
  const sentences = text.split(/[.!?;:]+(?:\s|$)/).filter((x) => x.trim());
  if (sentences.some((x) => letterWords(x).length > rl.sentence)) return true;
  const plain = words.filter((w) => !isAllowed(w));
  if (plain.length < 3) return false;
  const lens = plain.map((w) => w.replace(/['’-]/g, "").length);
  const long = lens.filter((n) => n >= LONG_WORD_LEN).length;
  const avg = lens.reduce((a, n) => a + n, 0) / lens.length;
  return avg > rl.avg || (long >= 2 && long / plain.length > rl.longRatio);
}
const optionTooHard = (opt, rl) => letterWords(opt).length > rl.opt;
const normKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") || s.trim().toLowerCase();

// Checks a generated string; adds stable codes only.
function checkText(s, errors) {
  if (/[\n\r\t]/.test(s) || HIDDEN_CHARS_RE.test(s) || FORBIDDEN_CHARS_RE.test(s) ||
      s.includes("://") || /www\./i.test(s) || s.includes("](")) errors.add("text_chars");
  if (hasUrl(s)) errors.add("text_url");
  if (EMAIL_RE.test(s) || HANDLE_RE.test(s) || PHONE_RE.test(s)) errors.add("text_contact");
  if (containsBanned(s)) errors.add("text_banned");
  if (REFUSAL_MARKER_RE.test(s)) errors.add("text_refusal");
}

function trimmed(v, min, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const n = cpLen(t);
  return n >= min && n <= max ? t : null;
}

module.exports = {
  isPlainObject, cpLen, hasOwn, EMOJI_RE, readingFor, letterWords, textTooHard, optionTooHard, normKey, checkText, trimmed,
};

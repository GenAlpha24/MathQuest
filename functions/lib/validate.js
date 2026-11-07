"use strict";
// Pure validators for untrusted model output. Return {ok:true,value} or {ok:false,errors:[codes]}.
// Error codes are stable strings and never contain model or user content.

const cfg = require("./config");
const { sanitizePrompt, containsBanned, hasUrl, hasContact, hasInjection, hasBadChars } = require("./prefilter");

const FIX_CODES = Object.freeze([
  "json", "size", "shape", "keys", "bool", "enum", "topic", "theme", "grade", "incoherent",
  "off_topic_attested", "title", "questions_count", "q_text", "q_options", "q_correct_index",
  "q_hint", "q_explanation", "q_emoji", "options_duplicate", "questions_duplicate",
  "text_chars", "text_url", "text_contact", "text_banned", "text_refusal", "reading_level",
]);

const CLASSIFICATION_KEYS = ["isSteam", "safe", "refusalReason", "subject", "topic", "theme", "grade", "difficulty"];
const REFUSAL_REASONS = ["none", "off_topic", "unsafe", "personal_info", "chitchat", "injection", "too_vague"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cpLen = (s) => Array.from(s).length;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function parseJson(raw, maxLen) {
  if (typeof raw !== "string") return isPlainObject(raw) ? { value: raw } : { error: "shape" };
  if (raw.length > maxLen) return { error: "size" };
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: "json" };
  }
}

function applyGradeAuthority(grade, hint) {
  if (!cfg.GRADES.includes(hint)) return grade;
  return Math.abs(grade - hint) <= 2 ? grade : hint;
}

// Free-text field from the classifier that will be reused downstream (topic/theme).
function cleanClassifierText(s, min, max) {
  if (typeof s !== "string") return false;
  const n = cpLen(s);
  if (n < min || n > max) return false;
  if (sanitizePrompt(s) !== s) return false;
  if (hasUrl(s) || hasContact(s) || hasInjection(s) || containsBanned(s) || hasBadChars(s)) return false;
  return true;
}

function validateClassification(raw, opts) {
  const gradeHint = opts && opts.gradeHint;
  const parsed = parseJson(raw, cfg.CLASSIFICATION_MAX_BYTES);
  if (parsed.error) return { ok: false, errors: [parsed.error] };
  const o = parsed.value;
  if (!isPlainObject(o)) return { ok: false, errors: ["shape"] };
  const keys = Object.keys(o);
  if (keys.some((k) => !CLASSIFICATION_KEYS.includes(k))) return { ok: false, errors: ["keys"] };
  const errors = [];
  for (const k of CLASSIFICATION_KEYS) if (k !== "theme" && !hasOwn(o, k)) errors.push("keys");
  if (errors.length) return { ok: false, errors: ["keys"] };

  if (typeof o.isSteam !== "boolean" || typeof o.safe !== "boolean") errors.push("bool");
  if (!REFUSAL_REASONS.includes(o.refusalReason) || !cfg.SUBJECTS.includes(o.subject) ||
      !cfg.DIFFICULTIES.includes(o.difficulty)) errors.push("enum");
  if (!Number.isInteger(o.grade) || !cfg.GRADES.includes(o.grade)) errors.push("grade");
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };

  const accepted = o.isSteam && o.safe;
  if ((o.refusalReason === "none") !== accepted) return { ok: false, errors: ["incoherent"] };

  const theme = o.theme === undefined ? null : o.theme;
  if (accepted) {
    if (!cleanClassifierText(o.topic, 3, 60)) errors.push("topic");
    if (theme !== null && !cleanClassifierText(theme, 2, 40)) errors.push("theme");
  } else if (typeof o.topic !== "string" || cpLen(o.topic) > 60 || (theme !== null && (typeof theme !== "string" || cpLen(theme) > 40))) {
    errors.push("topic");
  }
  if (errors.length) return { ok: false, errors };

  const hint = Number.isInteger(gradeHint) ? gradeHint : o.grade;
  return {
    ok: true,
    value: {
      isSteam: o.isSteam,
      safe: o.safe,
      refusalReason: o.refusalReason,
      subject: o.subject,
      // Rejected requests never reuse model text.
      topic: accepted ? o.topic.trim() : "none",
      theme: accepted ? (theme === null ? null : theme.trim()) : null,
      grade: applyGradeAuthority(o.grade, hint),
      difficulty: o.difficulty,
    },
  };
}

// ---- game validation ----
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
const wordsOf = (s) => s.split(/\s+/).filter(Boolean);
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

// Checks a generated string; pushes stable codes only.
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

function validateGame(raw, opts) {
  const grade = opts && Number.isInteger(opts.grade) && cfg.GRADES.includes(opts.grade) ? opts.grade : 1;
  const count = Math.min(cfg.MAX_QUESTIONS, Math.max(cfg.MIN_QUESTIONS,
    opts && Number.isInteger(opts.count) ? opts.count : cfg.DEFAULT_QUESTIONS));
  const parsed = parseJson(raw, cfg.GAME_MAX_BYTES);
  if (parsed.error) return { ok: false, errors: [parsed.error] };
  const o = parsed.value;
  if (!isPlainObject(o)) return { ok: false, errors: ["shape"] };

  const errors = new Set();
  if (o.stayedOnSteamTopic !== true) errors.add("off_topic_attested");

  const title = trimmed(o.title, 3, 60);
  if (title === null) errors.add("title");
  else checkText(title, errors);

  const out = [];
  if (!Array.isArray(o.questions) || o.questions.length < cfg.MIN_QUESTIONS || o.questions.length > count) {
    errors.add("questions_count");
  } else {
    const rl = readingFor(grade);
    const seen = new Set();
    o.questions.forEach((q, i) => {
      if (!isPlainObject(q)) { errors.add("shape"); return; }
      const text = trimmed(q.text, 8, 200);
      if (text === null) errors.add("q_text");
      else {
        checkText(text, errors);
        if (textTooHard(text, rl)) errors.add("reading_level");
        const key = normKey(text);
        if (seen.has(key)) errors.add("questions_duplicate");
        seen.add(key);
      }

      let options = null;
      if (Array.isArray(q.options) && q.options.length >= 3 && q.options.length <= 4) {
        const opts2 = q.options.map((x) => trimmed(x, 1, 60));
        if (opts2.every((x) => x !== null)) options = opts2;
      }
      if (options === null) errors.add("q_options");
      else {
        options.forEach((x) => {
          checkText(x, errors);
          if (optionTooHard(x, rl)) errors.add("reading_level");
        });
        if (new Set(options.map(normKey)).size !== options.length) errors.add("options_duplicate");
      }

      const ci = q.correctIndex;
      if (!Number.isInteger(ci) || options === null || ci < 0 || ci >= options.length) errors.add("q_correct_index");

      const hint = trimmed(q.hint, 5, 200);
      if (hint === null) errors.add("q_hint"); else checkText(hint, errors);
      const explanation = trimmed(q.explanation, 5, 240);
      if (explanation === null) errors.add("q_explanation"); else checkText(explanation, errors);

      let emoji;
      if (q.emoji !== undefined && q.emoji !== null) {
        if (typeof q.emoji !== "string" || q.emoji.length > 8 || !EMOJI_RE.test(q.emoji)) errors.add("q_emoji");
        else emoji = q.emoji;
      }

      const item = { id: "q" + (i + 1), text, options, correctIndex: ci, hint, explanation };
      if (emoji !== undefined) item.emoji = emoji;
      out.push(item);
    });
  }

  if (errors.size) return { ok: false, errors: [...errors] };
  return { ok: true, value: { title, questions: out } };
}

module.exports = {
  FIX_CODES, CLASSIFICATION_KEYS, REFUSAL_REASONS, validateClassification, validateGame, applyGradeAuthority,
};

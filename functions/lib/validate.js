"use strict";
// Pure validators for untrusted model output. Return {ok:true,value} or {ok:false,errors:[codes]}.
// Error codes are stable strings and never contain model or user content.

const cfg = require("./config");
const { sanitizePrompt, containsBanned, hasUrl, hasContact, hasInjection, hasBadChars } = require("./prefilter");
const {
  isPlainObject, cpLen, hasOwn, readingFor, letterWords, textTooHard, optionTooHard, normKey, checkText, trimmed,
} = require("./text");
const { KINDS, LIMITS, validateVisual, validateAnswerCheck, opsFor, answerConsistent, emojiOk } = require("./visuals");
const { TEMPLATES, TEMPLATE_IDS, COUNTS, familyOf, hostKindsFor } = require("./templates");

const FIX_CODES = Object.freeze([
  "json", "size", "shape", "keys", "bool", "enum", "topic", "theme", "grade", "incoherent",
  "off_topic_attested", "title", "questions_count", "q_text", "q_options", "q_correct_index",
  "q_hint", "q_explanation", "q_emoji", "options_duplicate", "questions_duplicate",
  "text_chars", "text_url", "text_contact", "text_banned", "text_refusal", "reading_level",
  "visual", "visual_kind", "visual_mismatch", "visual_missing", "pairs_count", "pair_shape", "rounds_count", "steps",
  "bins", "items_count", "item_bin", "sort_balance", "labels_duplicate",
]);

const CLASSIFICATION_KEYS = ["isSteam", "safe", "refusalReason", "subject", "topic", "theme", "grade", "difficulty", "template", "fits", "visualKinds"];
// Optional for the validator (older scripted classifiers omit them); the Vertex schema requires template, fits and visualKinds.
const OPTIONAL_CLASSIFICATION_KEYS = ["theme", "template", "fits", "visualKinds"];
const REFUSAL_REASONS = ["none", "off_topic", "unsafe", "personal_info", "chitchat", "injection", "too_vague"];

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
  for (const k of CLASSIFICATION_KEYS) if (!OPTIONAL_CLASSIFICATION_KEYS.includes(k) && !hasOwn(o, k)) errors.push("keys");
  if (errors.length) return { ok: false, errors: ["keys"] };

  if (typeof o.isSteam !== "boolean" || typeof o.safe !== "boolean") errors.push("bool");
  if (!REFUSAL_REASONS.includes(o.refusalReason) || !cfg.SUBJECTS.includes(o.subject) ||
      !cfg.DIFFICULTIES.includes(o.difficulty)) errors.push("enum");
  if (!Number.isInteger(o.grade) || !cfg.GRADES.includes(o.grade)) errors.push("grade");
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };

  let template = "quiz";
  let fits = ["quiz"];
  let visualKinds = [];
  if (hasOwn(o, "template")) { if (TEMPLATE_IDS.includes(o.template)) template = o.template; else errors.push("enum"); }
  if (hasOwn(o, "fits")) {
    if (Array.isArray(o.fits) && o.fits.length >= 1 && o.fits.length <= TEMPLATE_IDS.length &&
        o.fits.every((x) => TEMPLATE_IDS.includes(x)) && new Set(o.fits).size === o.fits.length) fits = o.fits.slice();
    else errors.push("enum");
  }
  if (hasOwn(o, "visualKinds")) {
    if (Array.isArray(o.visualKinds) && o.visualKinds.length <= 2 && o.visualKinds.every((x) => KINDS.includes(x)) &&
        new Set(o.visualKinds).size === o.visualKinds.length) visualKinds = o.visualKinds.slice();
    else errors.push("enum");
  }
  if (!errors.length && !fits.includes(template)) errors.push("enum");
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  // The choice family fits every topic, so a fallback always exists.
  for (const t of ["quiz", "picturequiz"]) if (!fits.includes(t)) fits.push(t);

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
      template,
      fits,
      visualKinds,
    },
  };
}

// ---- game validation ----
function emojiField(v, errors, code) {
  if (v === undefined || v === null) return undefined;
  if (!emojiOk(v)) { errors.add(code); return undefined; }
  return v;
}

// Shared per-game context for the family validators.
function makeCtx(template, opts, grade) {
  const hostKinds = hostKindsFor(template);
  const kinds = Array.isArray(opts.allowedKinds) ? opts.allowedKinds.filter((k) => hostKinds.includes(k)) : [];
  return { errors: new Set(), rl: readingFor(grade), allowedKinds: kinds, visuals: 0, template, host: TEMPLATES[template].host };
}

// Optional picture on an item. Returns the normalized visual or undefined (errors recorded on failure).
function takeVisual(raw, ctx) {
  if (raw === undefined || raw === null) return undefined;
  if (ctx.visuals >= LIMITS.maxPerGame) { ctx.errors.add("visual"); return undefined; }
  ctx.visuals++;
  const r = validateVisual(raw, { host: ctx.host, allowedKinds: ctx.allowedKinds, rl: ctx.rl });
  if (!r.ok) { ctx.errors.add(r.code); return undefined; }
  return r.value;
}

const isAbsent = (x) => x === undefined || x === null;

function choiceFamily(o, ctx, count) {
  const { errors, rl } = ctx;
  const out = [];
  if (!Array.isArray(o.questions) || o.questions.length < cfg.MIN_QUESTIONS || o.questions.length > count) {
    errors.add("questions_count");
    return null;
  }
  const seen = new Set();
  const hv = []; // whether the model offered a picture (valid or not), so one bad picture is not also reported as missing
  const okinds = opsFor(ctx.allowedKinds);
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
        if (ctx.template === "catch" && letterWords(x).length > 3) errors.add("q_options");
      });
      if (new Set(options.map(normKey)).size !== options.length) errors.add("options_duplicate");
    }

    const ci = q.correctIndex;
    if (!Number.isInteger(ci) || options === null || ci < 0 || ci >= options.length) errors.add("q_correct_index");

    const hint = trimmed(q.hint, 5, 200);
    if (hint === null) errors.add("q_hint"); else checkText(hint, errors);
    const explanation = trimmed(q.explanation, 5, 240);
    if (explanation === null) errors.add("q_explanation"); else checkText(explanation, errors);

    const emoji = emojiField(q.emoji, errors, "q_emoji");

    const hasVisual = !isAbsent(q.visual);
    const visual = hasVisual ? takeVisual(q.visual, ctx) : undefined;
    if (!isAbsent(q.answerCheck)) {
      if (!hasVisual) errors.add("visual_mismatch");
      else if (visual) {
        const a = validateAnswerCheck(q.answerCheck, visual, okinds);
        if (!a.ok) errors.add(a.code);
        else if (options !== null && Number.isInteger(ci) && !answerConsistent(visual, a.value, options, ci)) errors.add("visual_mismatch");
      }
    }

    const item = { id: "q" + (i + 1), text, options, correctIndex: ci, hint, explanation };
    if (emoji !== undefined) item.emoji = emoji;
    if (visual !== undefined) item.visual = visual;
    out.push(item);
    hv.push(hasVisual);
  });
  if (ctx.template === "picturequiz" && ctx.allowedKinds.length) {
    if (out.some((q, i) => !hv[i] && !q.emoji) || hv.filter(Boolean).length * 2 < out.length) errors.add("visual_missing");
  }
  return { questions: out };
}

// One side of a memory pair, a step, or a sort item: short label, optional emoji, optional picture.
function labelled(s, ctx, code, max, extraWords, min) {
  if (!isPlainObject(s)) { ctx.errors.add(code); return null; }
  const label = trimmed(s.label, min || 1, max);
  if (label === null) { ctx.errors.add(code); return null; }
  checkText(label, ctx.errors);
  const rl = ctx.rl;
  if (letterWords(label).length > rl.opt + (extraWords || 0)) ctx.errors.add("reading_level");
  const out = { label };
  const emoji = emojiField(s.emoji, ctx.errors, code);
  if (emoji !== undefined) out.emoji = emoji;
  const visual = takeVisual(s.visual, ctx);
  if (visual !== undefined) out.visual = visual;
  return out;
}

function hintAndExplanation(r, errors, target) {
  const hint = trimmed(r.hint, 5, 200);
  if (hint === null) errors.add("q_hint"); else checkText(hint, errors);
  const explanation = trimmed(r.explanation, 5, 240);
  if (explanation === null) errors.add("q_explanation"); else checkText(explanation, errors);
  target.hint = hint;
  target.explanation = explanation;
}

function memoryFamily(o, ctx) {
  const { errors } = ctx;
  const c = COUNTS.memory;
  if (!Array.isArray(o.pairs) || o.pairs.length < c.min || o.pairs.length > c.max) { errors.add("pairs_count"); return null; }
  const seen = new Set();
  const pairs = [];
  o.pairs.forEach((p, i) => {
    if (!isPlainObject(p)) { errors.add("pair_shape"); return; }
    const a = labelled(p.a, ctx, "pair_shape", 30);
    const b = labelled(p.b, ctx, "pair_shape", 30);
    const item = { id: "p" + (i + 1), a, b };
    hintAndExplanation(p, errors, item);
    for (const s of [a, b]) {
      if (!s) continue;
      const key = normKey(s.label);
      if (seen.has(key)) errors.add("labels_duplicate");
      seen.add(key);
    }
    pairs.push(item);
  });
  return { pairs };
}

function sequenceFamily(o, ctx) {
  const { errors, rl } = ctx;
  const c = COUNTS.sequence;
  if (!Array.isArray(o.rounds) || o.rounds.length < c.min || o.rounds.length > c.max) { errors.add("rounds_count"); return null; }
  const rounds = [];
  o.rounds.forEach((r, i) => {
    if (!isPlainObject(r)) { errors.add("shape"); return; }
    const prompt = trimmed(r.prompt, 8, 120);
    if (prompt === null) errors.add("q_text");
    else { checkText(prompt, errors); if (textTooHard(prompt, rl)) errors.add("reading_level"); }
    let steps = null;
    if (Array.isArray(r.steps) && r.steps.length >= c.minSteps && r.steps.length <= c.maxSteps) {
      const list = r.steps.map((s) => labelled(s, ctx, "steps", 40, 3, 2));
      if (list.every((x) => x !== null)) {
        steps = list;
        if (new Set(list.map((x) => normKey(x.label))).size !== list.length) errors.add("steps");
      }
    } else errors.add("steps");
    const item = { id: "r" + (i + 1), prompt, steps };
    hintAndExplanation(r, errors, item);
    rounds.push(item);
  });
  return { rounds };
}

function sortFamily(o, ctx) {
  const { errors } = ctx;
  const c = COUNTS.sort;
  let bins = null;
  if (Array.isArray(o.bins) && o.bins.length >= c.minBins && o.bins.length <= c.maxBins) {
    const list = o.bins.map((b, i) => {
      if (!isPlainObject(b)) return null;
      const label = trimmed(b.label, 1, 20);
      const rule = trimmed(b.rule, 3, 60);
      if (label === null || rule === null) return null;
      checkText(label, errors);
      checkText(rule, errors);
      if (letterWords(label).length > ctx.rl.opt) errors.add("reading_level");
      const bin = { id: "b" + (i + 1), label };
      const emoji = emojiField(b.emoji, errors, "bins");
      if (emoji !== undefined) bin.emoji = emoji;
      bin.rule = rule;
      return bin;
    });
    if (list.every((x) => x !== null) && new Set(list.map((x) => normKey(x.label))).size === list.length) bins = list;
  }
  if (bins === null) errors.add("bins");
  if (!Array.isArray(o.items) || o.items.length < c.min || o.items.length > c.max) { errors.add("items_count"); return null; }
  const seen = new Set();
  const per = bins ? bins.map(() => 0) : [];
  const items = [];
  o.items.forEach((it, i) => {
    const base = labelled(it, ctx, "shape", 30);
    if (!base) return;
    const key = normKey(base.label);
    if (seen.has(key)) errors.add("labels_duplicate");
    seen.add(key);
    const explanation = trimmed(it.explanation, 5, 240);
    if (explanation === null) errors.add("q_explanation"); else checkText(explanation, errors);
    const bi = it.bin;
    if (!Number.isInteger(bi) || bi < 0 || (bins && bi >= bins.length)) errors.add("item_bin");
    else if (bins) per[bi]++;
    items.push({ id: "i" + (i + 1), ...base, bin: bi, explanation });
  });
  if (bins && per.length && items.length === o.items.length) {
    if (per.some((n) => n < 2) || per.some((n) => n > items.length * 0.7)) errors.add("sort_balance");
  }
  return { bins: bins || [], items };
}

const FAMILY_KEYS = { choice: ["questions"], memory: ["pairs"], sequence: ["rounds"], sort: ["bins", "items"] };

// opts: { template ("quiz" default), grade, count, allowedKinds ([] default) }. Defaults reproduce the v1 behavior.
function validateGame(raw, opts) {
  const o_ = opts || {};
  const template = typeof o_.template === "string" && hasOwn(TEMPLATES, o_.template) ? o_.template : "quiz";
  const family = familyOf(template);
  const grade = Number.isInteger(o_.grade) && cfg.GRADES.includes(o_.grade) ? o_.grade : 1;
  const count = Math.min(cfg.MAX_QUESTIONS, Math.max(cfg.MIN_QUESTIONS,
    Number.isInteger(o_.count) ? o_.count : cfg.DEFAULT_QUESTIONS));
  const parsed = parseJson(raw, cfg.GAME_MAX_BYTES);
  if (parsed.error) return { ok: false, errors: [parsed.error] };
  const o = parsed.value;
  if (!isPlainObject(o)) return { ok: false, errors: ["shape"] };

  const ctx = makeCtx(template, o_, grade);
  const { errors } = ctx;
  if (o.stayedOnSteamTopic !== true) errors.add("off_topic_attested");

  const title = trimmed(o.title, 3, 60);
  if (title === null) errors.add("title");
  else checkText(title, errors);

  // A document may carry only its own family's payload keys (blocks cross-template confusion).
  for (const [fam, keys] of Object.entries(FAMILY_KEYS)) {
    if (fam !== family && keys.some((k) => hasOwn(o, k) && !isAbsent(o[k]))) errors.add("shape");
  }

  let payload = null;
  if (family === "memory") payload = memoryFamily(o, ctx);
  else if (family === "sequence") payload = sequenceFamily(o, ctx);
  else if (family === "sort") payload = sortFamily(o, ctx);
  else payload = choiceFamily(o, ctx, count);

  if (errors.size || !payload) return { ok: false, errors: errors.size ? [...errors] : ["shape"] };
  return { ok: true, value: { title, ...payload } };
}

module.exports = {
  FIX_CODES, CLASSIFICATION_KEYS, REFUSAL_REASONS, validateClassification, validateGame, applyGradeAuthority,
};

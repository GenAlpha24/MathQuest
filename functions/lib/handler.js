"use strict";
// handleGenerate(request, deps): all orchestration for the generateGame callable.
// deps = { db, model:{classify,generate}, now:()=>Date, logger, quota? }. See design sec 1.1 and 1.4.
// Logs carry ids, codes and counts only. Never the prompt, model text, names, or SDK error messages.

const { HttpsError } = require("firebase-functions/v2/https");
const cfg = require("./config");
const { sanitizePrompt, prefilter } = require("./prefilter");
const { validateClassification, validateGame } = require("./validate");
const { buildClassifyRequest, buildGenerateRequest, REFUSALS, PROMPT_VERSION } = require("./prompts");

const fail = (code, detail, msg) => new HttpsError(code, msg, { code: detail });
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

function parseArgs(data) {
  const d = data !== null && typeof data === "object" ? data : {};
  if (typeof d.prompt !== "string" || d.prompt.length === 0 || d.prompt.length > cfg.RAW_PROMPT_CAP) {
    throw fail("invalid-argument", "prompt", "Invalid request.");
  }
  let grade;
  if (d.grade !== undefined && d.grade !== null) {
    if (!isInt(d.grade) || !cfg.GRADES.includes(d.grade)) throw fail("invalid-argument", "grade", "Invalid request.");
    grade = d.grade;
  }
  let count = cfg.DEFAULT_QUESTIONS;
  if (d.count !== undefined && d.count !== null) {
    if (!isInt(d.count) || d.count < cfg.MIN_QUESTIONS || d.count > cfg.MAX_QUESTIONS) throw fail("invalid-argument", "count", "Invalid request.");
    count = d.count;
  }
  return { prompt: d.prompt, grade, count };
}

async function handleGenerate(request, deps) {
  const { db, model, now, logger } = deps;
  const quota = deps.quota || require("./quota");
  const t0 = Date.now();
  const deadline = t0 + cfg.TOTAL_BUDGET_MS;
  const canRetry = () => deadline - Date.now() >= cfg.RETRY_MIN_REMAINING_MS;

  const uid = request && request.auth && request.auth.uid;
  const log = (level, fields) => {
    const fn = logger && logger[level];
    if (fn) fn.call(logger, "generateGame", { event: "generateGame", uid: uid || null, latencyMs: Date.now() - t0, ...fields });
  };
  const errFields = (e) => ({
    errName: e && e.name ? String(e.name) : "Error",
    errStatus: e && (typeof e.status === "number" || typeof e.code === "number") ? (e.status || e.code) : undefined,
  });

  // 1. auth
  if (!uid) { log("warn", { outcome: "unauth" }); throw new HttpsError("unauthenticated", "Please log in."); }

  // 2. arguments
  let args;
  try { args = parseArgs(request.data); } catch (e) { log("info", { outcome: "invalid_" + (e.details && e.details.code) }); throw e; }

  // 3. pre-filter: free, no quota, no model
  const prompt = sanitizePrompt(args.prompt);
  const pre = prefilter(prompt);
  if (!pre.ok) {
    log("info", { outcome: "prefilter_" + pre.reason });
    return { status: "refused", reason: pre.reason, message: REFUSALS[pre.reason] || REFUSALS.too_vague, remaining: null };
  }

  // 4. reserve (role gate + quota + lock)
  let ctx;
  try {
    ctx = await quota.reserve(db, uid, now());
  } catch (e) {
    if (e instanceof HttpsError) {
      const detail = e.details && e.details.code;
      log(detail === "global_cap" || detail === "profile" ? "warn" : "info", { outcome: "reserve_" + detail });
      throw e;
    }
    log("error", { outcome: "reserve_store", ...errFields(e) });
    throw fail("unavailable", "store", "Try again soon.");
  }

  const settle = async (result) => {
    try {
      return await quota.finish(db, ctx, now(), result);
    } catch (e) {
      log("error", { outcome: "finish_failed", ...errFields(e) });
      return null;
    }
  };
  const failModel = async (outcome, detail = "model") => {
    await settle({ outcome: "failure", refund: true });
    log("warn", { outcome });
    return fail("unavailable", detail, "Try again soon.");
  };

  try {
    const gradeHint = args.grade !== undefined ? args.grade : ctx.grade;

    // 5. classify (<= 2 attempts; a safety block never retries)
    let cls = null;
    for (let attempt = 1; attempt <= 2 && !cls; attempt++) {
      let res = null;
      try {
        res = await model.classify(buildClassifyRequest({ prompt, gradeHint }));
      } catch (e) {
        log("warn", { outcome: "classify_error", attempt, ...errFields(e) });
      }
      if (res && res.blocked) {
        const s = await settle({ outcome: "refused" });
        log("info", { outcome: "classify_blocked", attempt });
        return { status: "refused", reason: "unsafe", message: REFUSALS.unsafe, remaining: s ? s.remaining : ctx.remaining };
      }
      if (res) {
        const v = validateClassification(res.text, { gradeHint });
        if (v.ok) cls = v.value;
        else log("warn", { outcome: "classify_invalid", attempt, inTokens: res.inTokens, outTokens: res.outTokens, checks: v.errors.join(",") });
      }
      if (!cls && (attempt === 2 || !canRetry())) throw await failModel("classify_failed");
    }

    // 6. classifier refusal
    if (!(cls.isSteam && cls.safe)) {
      const s = await settle({ outcome: "refused" });
      const reason = REFUSALS[cls.refusalReason] && cls.refusalReason !== "none" ? cls.refusalReason : "off_topic";
      log("info", { outcome: "classify_refused_" + reason });
      return { status: "refused", reason, message: REFUSALS[reason], remaining: s ? s.remaining : ctx.remaining };
    }

    // 7. generate (<= 2 attempts); only validated classifier fields go to the model
    let game = null;
    let fixes;
    let blocks = 0;
    let attempts = 0;
    let invalid = 0;
    for (let attempt = 1; attempt <= 2 && !game; attempt++) {
      attempts = attempt;
      let res = null;
      try {
        res = await model.generate(buildGenerateRequest({
          subject: cls.subject, topic: cls.topic, theme: cls.theme, grade: cls.grade,
          difficulty: cls.difficulty, questionCount: args.count, fixes,
        }));
      } catch (e) {
        log("warn", { outcome: "gen_error", attempt, ...errFields(e) });
      }
      fixes = undefined;
      if (res && res.blocked) {
        blocks++;
        log("info", { outcome: "gen_blocked", attempt });
      } else if (res) {
        const v = res.finishReason === "MAX_TOKENS" ? { ok: false, errors: ["json"] } : validateGame(res.text, { count: args.count, grade: cls.grade });
        if (v.ok) game = v.value;
        else {
          invalid++;
          fixes = v.errors;
          log("warn", { outcome: "gen_invalid", attempt, inTokens: res.inTokens, outTokens: res.outTokens, checks: v.errors.join(",") });
        }
      }
      if (!game && attempt < 2 && !canRetry()) break;
    }
    if (!game) {
      if (blocks === 2 && attempts === 2) {
        const s = await settle({ outcome: "refused" });
        return { status: "refused", reason: "unsafe", message: REFUSALS.unsafe, remaining: s ? s.remaining : ctx.remaining };
      }
      // Model answered but never produced a valid game (details.code "gen_failed") vs. no usable answer at all ("model").
      throw await failModel("gen_failed", invalid > 0 ? "gen_failed" : "model");
    }

    // 8. save game + counters in one transaction
    const doc = {
      schemaVersion: 1, type: "quiz", status: "ok",
      title: game.title, subject: cls.subject, topic: cls.topic, grade: cls.grade, difficulty: cls.difficulty,
      prompt, questions: game.questions, questionCount: game.questions.length,
      createdBy: uid, creatorRole: ctx.role, model: cfg.MODEL_ID, promptVersion: PROMPT_VERSION,
    };
    let saved;
    try {
      saved = await quota.finish(db, ctx, now(), { game: doc });
    } catch (e) {
      log("error", { outcome: "save_failed", ...errFields(e) });
      try { await quota.finish(db, ctx, now(), { outcome: "failure", refund: true }); } catch (e2) { /* best effort */ }
      throw fail("unavailable", "store", "Try again soon.");
    }

    // 9. respond
    log("info", { outcome: "ok", gameId: saved.gameId });
    const { createdBy, creatorRole, ...publicGame } = doc;
    return { status: "ok", gameId: saved.gameId, game: publicGame, remaining: saved.remaining };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    log("error", { outcome: "internal", ...errFields(e) });
    try { await quota.finish(db, ctx, now(), { outcome: "failure", refund: true }); } catch (e2) { /* best effort */ }
    throw new HttpsError("internal", "Something went wrong.");
  }
}

module.exports = { handleGenerate, parseArgs };

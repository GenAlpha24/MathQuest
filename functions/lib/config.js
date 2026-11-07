"use strict";
// Single place for every tunable. To change the model, edit MODEL_ID only.

const MODEL_ID = "gemini-3.8-flash";
const FUNCTIONS_REGION = "us-central1";
const DEFAULT_VERTEX_LOCATION = "us";

const GRADES = Object.freeze([-2, -1, 0, 1, 2, 3, 4, 5]);
const SUBJECTS = Object.freeze(["Science", "Technology", "Engineering", "Art", "Math"]);
const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);

const limits = Object.freeze({
  STUDENT_DAILY: 10,
  ADULT_DAILY: 25,
  GLOBAL_DAILY: 1000,
  REFUND_CAP: 3,
  LOCK_SECONDS: 120,
  PROMPT_MIN: 3,
  PROMPT_MAX: 200,
  RAW_PROMPT_CAP: 2000,
  MIN_QUESTIONS: 5,
  MAX_QUESTIONS: 15,
  DEFAULT_QUESTIONS: 8,
  CLASSIFY_MAX_OUTPUT_TOKENS: 1024,
  GENERATE_MAX_OUTPUT_TOKENS: 16384,
  CLASSIFY_TIMEOUT_MS: 15000,
  GENERATE_TIMEOUT_MS: 40000,
  TOTAL_BUDGET_MS: 80000,
  RETRY_MIN_REMAINING_MS: 25000,
  CLASSIFICATION_MAX_BYTES: 4096,
  GAME_MAX_BYTES: 65536,
  GAME_RETENTION_DAYS: 365,
  USAGE_RETENTION_DAYS: 3,
});

module.exports = {
  MODEL_ID,
  FUNCTIONS_REGION,
  DEFAULT_VERTEX_LOCATION,
  GRADES,
  SUBJECTS,
  DIFFICULTIES,
  limits,
  GLOBAL_DAILY_CAP: limits.GLOBAL_DAILY,
  ...limits,
};

"use strict";
// Template catalogue, per-family Vertex response schemas and the pure template chooser. No I/O.

const cfg = require("./config");
const { KINDS, KEYS, HOSTS, LIMITS, OPS, opsFor } = require("./visuals");

const TEMPLATES = Object.freeze({
  quiz: { family: "choice", host: "question" },
  picturequiz: { family: "choice", host: "question" },
  catch: { family: "choice", host: "question" },
  memory: { family: "memory", host: "memory" },
  sequence: { family: "sequence", host: "sequence" },
  sort: { family: "sort", host: "sort" },
});
const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
const COUNTS = Object.freeze({
  choice: { min: cfg.MIN_QUESTIONS, max: cfg.MAX_QUESTIONS, default: cfg.DEFAULT_QUESTIONS },
  memory: { min: cfg.MEMORY_MIN_PAIRS, max: cfg.MEMORY_MAX_PAIRS, default: 5 },
  sequence: { min: cfg.SEQUENCE_MIN_ROUNDS, max: cfg.SEQUENCE_MAX_ROUNDS, default: 4, minSteps: cfg.SEQUENCE_MIN_STEPS, maxSteps: cfg.SEQUENCE_MAX_STEPS },
  sort: { min: cfg.SORT_MIN_ITEMS, max: cfg.SORT_MAX_ITEMS, default: 10, minBins: cfg.SORT_MIN_BINS, maxBins: cfg.SORT_MAX_BINS },
});

const familyOf = (template) => (TEMPLATES[template] || TEMPLATES.quiz).family;
const hostKindsFor = (template) => HOSTS[(TEMPLATES[template] || TEMPLATES.quiz).host];
const itemCountFor = (template, count) => (familyOf(template) === "choice" ? count : COUNTS[familyOf(template)].default);

// ---- Vertex schema builders (only fields listed in prompts.SUPPORTED_SCHEMA_FIELDS) ----
const STR = (extra) => ({ type: "STRING", ...extra });
const INT = () => ({ type: "INTEGER" });
const nul = (s) => ({ ...s, nullable: true });
const arr = (items, min, max) => {
  const a = { type: "ARRAY", items };
  if (min !== undefined) a.minItems = min;
  if (max !== undefined) a.maxItems = max;
  return a;
};
const obj = (properties, required, order) => ({ type: "OBJECT", propertyOrdering: order || Object.keys(properties), properties, required });

const VISUAL_PROPS = {
  title: STR(),
  yLabel: STR(),
  showValues: { type: "BOOLEAN" },
  bars: arr(obj({ label: STR(), value: INT(), emoji: nul(STR()) }, ["label", "value"]), LIMITS.bars[0], LIMITS.bars[1]),
  parts: INT(),
  shaded: INT(),
  theme: STR({ enum: [...LIMITS.pieThemes] }),
  min: INT(),
  max: INT(),
  step: INT(),
  marks: arr(INT(), undefined, LIMITS.lineMarks),
  hour: INT(),
  minute: INT(),
  showDigital: { type: "BOOLEAN" },
  shape: STR({ enum: [...LIMITS.shapes] }),
  sideLabels: arr(INT(), undefined, 6),
  lengthUnit: STR({ enum: [...LIMITS.lengthUnits] }),
  splitParts: INT(),
  splitShaded: INT(),
  emoji: STR(),
  count: INT(),
  groupSize: INT(),
  crossed: INT(),
  keyEmoji: STR(),
  keyEach: INT(),
  rows: arr(obj({ label: STR(), count: INT() }, ["label", "count"]), LIMITS.pictoRows[0], LIMITS.pictoRows[1]),
  value: INT(),
  tempUnit: STR({ enum: [...LIMITS.tempUnits] }),
};

// Flat visual object limited to the kinds asked for, or undefined when there are none.
function visualSchema(kinds) {
  const use = KINDS.filter((k) => (kinds || []).includes(k));
  if (!use.length) return undefined;
  const keys = [];
  for (const k of use) for (const key of KEYS[k]) if (!keys.includes(key)) keys.push(key);
  const properties = { kind: STR({ enum: use }) };
  for (const key of keys) properties[key] = nul(VISUAL_PROPS[key]);
  return nul(obj(properties, ["kind"], ["kind", ...keys]));
}

function answerCheckSchema(kinds) {
  const ops = opsFor((kinds || []).filter((k) => OPS[k]));
  if (!ops.length) return undefined;
  return nul(obj({ op: STR({ enum: ops }), label: nul(STR()), label2: nul(STR()) }, ["op"]));
}

const withExtras = (properties, order, extras) => {
  for (const [k, s] of Object.entries(extras)) if (s) { properties[k] = s; order.push(k); }
};

function choiceSchema(kinds) {
  const props = {
    text: STR(), options: arr(STR(), 3, 4), correctIndex: { type: "INTEGER", minimum: 0, maximum: 3 },
    hint: STR(), explanation: STR(), emoji: nul(STR()),
  };
  const order = ["text", "options", "correctIndex", "hint", "explanation", "emoji"];
  withExtras(props, order, { visual: visualSchema(kinds), answerCheck: answerCheckSchema(kinds) });
  return obj({
    stayedOnSteamTopic: { type: "BOOLEAN" }, title: STR(),
    questions: arr(obj(props, ["text", "options", "correctIndex", "hint", "explanation"], order), cfg.MIN_QUESTIONS, cfg.MAX_QUESTIONS),
  }, ["stayedOnSteamTopic", "title", "questions"], ["stayedOnSteamTopic", "title", "questions"]);
}

function labelled(kinds, extra, required) {
  const props = { label: STR(), emoji: nul(STR()), ...extra };
  const order = Object.keys(props);
  const v = visualSchema(kinds);
  if (v) { props.visual = v; order.push("visual"); }
  return obj(props, required || ["label"], order);
}

function memorySchema(kinds) {
  const side = labelled(kinds, {});
  const pair = obj({ a: side, b: side, hint: STR(), explanation: STR() }, ["a", "b", "hint", "explanation"]);
  return obj({
    stayedOnSteamTopic: { type: "BOOLEAN" }, title: STR(), pairs: arr(pair, COUNTS.memory.min, COUNTS.memory.max),
  }, ["stayedOnSteamTopic", "title", "pairs"]);
}

function sequenceSchema(kinds) {
  const round = obj({
    prompt: STR(), steps: arr(labelled(kinds, {}), COUNTS.sequence.minSteps, COUNTS.sequence.maxSteps), hint: STR(), explanation: STR(),
  }, ["prompt", "steps", "hint", "explanation"]);
  return obj({
    stayedOnSteamTopic: { type: "BOOLEAN" }, title: STR(), rounds: arr(round, COUNTS.sequence.min, COUNTS.sequence.max),
  }, ["stayedOnSteamTopic", "title", "rounds"]);
}

function sortSchema(kinds) {
  const bin = obj({ label: STR(), emoji: nul(STR()), rule: STR() }, ["label", "rule"]);
  const item = labelled(kinds, { bin: INT(), explanation: STR() }, ["label", "bin", "explanation"]);
  return obj({
    stayedOnSteamTopic: { type: "BOOLEAN" }, title: STR(),
    bins: arr(bin, COUNTS.sort.minBins, COUNTS.sort.maxBins), items: arr(item, COUNTS.sort.min, COUNTS.sort.max),
  }, ["stayedOnSteamTopic", "title", "bins", "items"]);
}

// Per-request Vertex responseSchema. allowedKinds are cut to what the template's host accepts.
function schemaFor(template, opts) {
  const t = TEMPLATES[template] ? template : "quiz";
  const hostKinds = hostKindsFor(t);
  const kinds = ((opts && opts.allowedKinds) || []).filter((k) => hostKinds.includes(k));
  switch (familyOf(t)) {
    case "memory": return memorySchema(kinds);
    case "sequence": return sequenceSchema(kinds);
    case "sort": return sortSchema(kinds);
    default: return choiceSchema(kinds);
  }
}

// Node count of a schema (objects, arrays, scalars): a proxy for Vertex "too complex" 400s, capped in tests.
function schemaComplexity(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + schemaComplexity(n), 0);
  if (!node || typeof node !== "object") return 0;
  let n = node.type ? 1 : 0;
  if (node.properties) for (const c of Object.values(node.properties)) n += schemaComplexity(c);
  if (node.items) n += schemaComplexity(node.items);
  return n;
}

// requested: undefined (legacy client) | "auto" | template id. fits: ordered, best first. recent: newest first.
function chooseTemplate({ requested, cls, fits, recent }) {
  if (requested === undefined) return { template: "quiz", source: "auto", note: null };
  const list = Array.isArray(fits) && fits.length ? fits : [cls.template];
  if (requested !== "auto") {
    if (list.includes(requested)) return { template: requested, source: "user", note: null };
    return { template: cls.template, source: "fallback", note: "fallback" };
  }
  const base = cls.template;
  const r = Array.isArray(recent) ? recent : [];
  if (r.length >= cfg.VARIETY_WINDOW && r.slice(0, cfg.VARIETY_WINDOW).every((t) => t === base)) {
    const other = list.find((t) => t !== base);
    if (other) return { template: other, source: "variety", note: null };
  }
  return { template: base, source: "auto", note: null };
}

module.exports = {
  TEMPLATES, TEMPLATE_IDS, COUNTS, familyOf, hostKindsFor, itemCountFor, schemaFor, visualSchema, answerCheckSchema,
  schemaComplexity, chooseTemplate,
};

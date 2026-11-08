"use strict";
// Declarative picture vocabulary: strict validation of model JSON, and answerCheck consistency.
// Pure. Output objects are rebuilt from allowlisted keys, so no model object reaches Firestore or the client.
// Failure codes are stable strings ("visual", "visual_kind", "visual_mismatch") and never carry model text.

const { isPlainObject, cpLen, hasOwn, EMOJI_RE, optionTooHard, normKey, checkText, trimmed } = require("./text");

const KINDS = Object.freeze(["barChart", "pie", "numberLine", "clock", "shape", "emojiGroup", "pictograph", "thermometer"]);
const COMPACT_KINDS = Object.freeze(["pie", "emojiGroup", "clock", "shape", "thermometer"]);
const HOSTS = Object.freeze({ question: KINDS, memory: COMPACT_KINDS, sequence: COMPACT_KINDS, sort: COMPACT_KINDS });

const LIMITS = Object.freeze({
  bars: [2, 8], barValue: [0, 100], label: [1, 14], title: 40, yLabel: 20,
  pieParts: [2, 12], pieThemes: ["pizza", "pie", "chocolate", "plain"],
  lineRange: [-100, 1000], lineSteps: [1, 2, 5, 10, 20, 25, 50, 100], lineTicks: [1, 20], lineMarks: 3,
  hour: [1, 12], minute: [0, 59],
  shapes: ["triangle", "square", "rectangle", "circle", "pentagon", "hexagon"], sideLabel: [1, 99],
  lengthUnits: ["cm", "m", "in", "none"], splitParts: [2, 3, 4, 6, 8],
  emojiCount: [1, 30], groupSize: [1, 10],
  pictoRows: [2, 6], pictoCount: [0, 10], pictoKeyEach: [1, 10], pictoTotal: 40,
  thermo: [-30, 120], thermoSpan: 150, tempUnits: ["C", "F"],
  maxBytes: 2048, maxPerGame: 15, emojiLen: 8,
});
const EDGES = Object.freeze({ triangle: 3, square: 4, rectangle: 4, pentagon: 5, hexagon: 6, circle: 0 });

// Emoji never allowed in pictures (weapons, blood, drugs, alcohol, smoking, gore, sexual, scatological). Mirrored in the client.
const EMOJI_DENY = Object.freeze([
  "🔫", "🗡", "🔪", "💣", "🧨", "🪓", "⚔", "🩸", "💉", "💊", "🚬", "🍺", "🍻", "🍷", "🥃", "🍸", "🍹", "🍾", "🥂",
  "☠", "💀", "💩", "🍆", "🔞", "🖕", "👙", "🩲", "🏴‍☠",
]);

const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];
const KEYS = Object.freeze({
  barChart: ["title", "yLabel", "showValues", "bars"],
  pie: ["parts", "shaded", "theme"],
  numberLine: ["min", "max", "step", "marks"],
  clock: ["hour", "minute", "showDigital"],
  shape: ["shape", "sideLabels", "lengthUnit", "splitParts", "splitShaded"],
  emojiGroup: ["emoji", "count", "groupSize", "crossed"],
  pictograph: ["title", "keyEmoji", "keyEach", "rows"],
  thermometer: ["min", "max", "value", "tempUnit"],
});

const inRange = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;
const absent = (x) => x === undefined || x === null;
const isArr = Array.isArray;

function emojiOk(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > LIMITS.emojiLen || !EMOJI_RE.test(s)) return false;
  const bare = s.replace(/\uFE0F/g, "");
  return !EMOJI_DENY.some((d) => bare.includes(d.replace(/\uFE0F/g, "")));
}

const VIS_LABEL_RE = /^[\p{L}\p{N} .,'’%/:+°-]+$/u;
// Plain short text for labels/titles. Returns trimmed string or null.
function labelOk(v, min, max, rl) {
  const t = trimmed(v, min, max);
  if (t === null || !VIS_LABEL_RE.test(t)) return null;
  const errs = new Set();
  checkText(t, errs);
  if (errs.size) return null;
  if (rl && optionTooHard(t, rl)) return null;
  return t;
}

function validateVisual(v, opts) {
  const host = (opts && opts.host) || "question";
  const allowedKinds = (opts && opts.allowedKinds) || [];
  const rl = opts && opts.rl;
  const bad = { ok: false, code: "visual" };
  if (!isPlainObject(v)) return bad;
  const ownKeys = Object.keys(v);
  if (ownKeys.some((k) => FORBIDDEN_KEYS.includes(k))) return bad;
  const kind = v.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return bad;
  if (!allowedKinds.includes(kind) || !(HOSTS[host] || []).includes(kind)) return { ok: false, code: "visual_kind" };
  // Keys of other kinds are tolerated only as null (the flat Vertex schema returns them); any real value fails.
  const own = new Set(["kind", ...KEYS[kind]]);
  const allKeys = new Set(["kind", ...[].concat(...Object.values(KEYS))]);
  for (const k of ownKeys) {
    if (own.has(k)) continue;
    if (!allKeys.has(k) || !absent(v[k])) return bad;
  }
  const g = (k) => (hasOwn(v, k) && !absent(v[k]) ? v[k] : undefined);
  let out = null;
  switch (kind) {
    case "barChart": out = barChart(g, rl); break;
    case "pie": out = pie(g); break;
    case "numberLine": out = numberLine(g); break;
    case "clock": out = clock(g); break;
    case "shape": out = shape(g); break;
    case "emojiGroup": out = emojiGroup(g); break;
    case "pictograph": out = pictograph(g, rl); break;
    case "thermometer": out = thermometer(g); break;
    default: out = null;
  }
  if (!out) return bad;
  if (JSON.stringify(out).length > LIMITS.maxBytes) return bad;
  return { ok: true, value: out };
}

function barChart(g, rl) {
  const bars = g("bars");
  if (!isArr(bars) || !inRange(bars.length, LIMITS.bars)) return null;
  const outBars = [];
  const seen = new Set();
  for (const b of bars) {
    if (!isPlainObject(b) || Object.keys(b).some((k) => FORBIDDEN_KEYS.includes(k))) return null;
    const label = labelOk(b.label, LIMITS.label[0], LIMITS.label[1], rl);
    if (label === null || !inRange(b.value, LIMITS.barValue)) return null;
    const key = normKey(label);
    if (seen.has(key)) return null;
    seen.add(key);
    const bar = { label, value: b.value };
    if (!absent(b.emoji)) { if (!emojiOk(b.emoji)) return null; bar.emoji = b.emoji; }
    outBars.push(bar);
  }
  const out = {};
  if (g("title") !== undefined) { const t = labelOk(g("title"), 1, LIMITS.title, rl); if (t === null) return null; out.title = t; }
  if (g("yLabel") !== undefined) { const t = labelOk(g("yLabel"), 1, LIMITS.yLabel, rl); if (t === null) return null; out.yLabel = t; }
  if (g("showValues") !== undefined) { if (typeof g("showValues") !== "boolean") return null; out.showValues = g("showValues"); }
  return { kind: "barChart", ...out, bars: outBars };
}

function pie(g) {
  const parts = g("parts"), shaded = g("shaded"), theme = g("theme");
  if (!inRange(parts, LIMITS.pieParts) || !inRange(shaded, [0, Number.isInteger(parts) ? parts : 0])) return null;
  if (!LIMITS.pieThemes.includes(theme)) return null;
  return { kind: "pie", parts, shaded, theme };
}

function numberLine(g) {
  const min = g("min"), max = g("max"), step = g("step"), marks = g("marks");
  if (!inRange(min, LIMITS.lineRange) || !inRange(max, LIMITS.lineRange) || min >= max) return null;
  if (!LIMITS.lineSteps.includes(step) || (max - min) % step !== 0 || !inRange((max - min) / step, LIMITS.lineTicks)) return null;
  const out = { kind: "numberLine", min, max, step };
  if (marks !== undefined) {
    if (!isArr(marks) || marks.length > LIMITS.lineMarks) return null;
    for (const m of marks) if (!Number.isInteger(m) || m < min || m > max || (m - min) % step !== 0) return null;
    if (new Set(marks).size !== marks.length) return null;
    if (marks.length) out.marks = marks.slice();
  }
  return out;
}

function clock(g) {
  if (!inRange(g("hour"), LIMITS.hour) || !inRange(g("minute"), LIMITS.minute)) return null;
  const out = { kind: "clock", hour: g("hour"), minute: g("minute") };
  if (g("showDigital") !== undefined) { if (typeof g("showDigital") !== "boolean") return null; out.showDigital = g("showDigital"); }
  return out;
}

function shape(g) {
  const sh = g("shape");
  if (!LIMITS.shapes.includes(sh)) return null;
  const out = { kind: "shape", shape: sh };
  const labels = g("sideLabels");
  if (labels !== undefined) {
    if (!isArr(labels) || labels.length !== EDGES[sh] || labels.length === 0) return null;
    if (!labels.every((n) => inRange(n, LIMITS.sideLabel))) return null;
    if (sh === "square" && new Set(labels).size !== 1) return null;
    if (sh === "rectangle" && !(labels[0] === labels[2] && labels[1] === labels[3])) return null;
    if (!LIMITS.lengthUnits.includes(g("lengthUnit"))) return null;
    out.sideLabels = labels.slice();
    out.lengthUnit = g("lengthUnit");
  }
  const sp = g("splitParts"), ss = g("splitShaded");
  if ((sp === undefined) !== (ss === undefined)) return null;
  if (sp !== undefined) {
    if (!["circle", "square", "rectangle"].includes(sh)) return null;
    if (!LIMITS.splitParts.includes(sp) || !inRange(ss, [0, sp])) return null;
    out.splitParts = sp;
    out.splitShaded = ss;
  }
  return out;
}

function emojiGroup(g) {
  if (!emojiOk(g("emoji")) || !inRange(g("count"), LIMITS.emojiCount)) return null;
  const out = { kind: "emojiGroup", emoji: g("emoji"), count: g("count") };
  if (g("groupSize") !== undefined) { if (!inRange(g("groupSize"), LIMITS.groupSize)) return null; out.groupSize = g("groupSize"); }
  if (g("crossed") !== undefined) { if (!inRange(g("crossed"), [0, g("count")])) return null; out.crossed = g("crossed"); }
  return out;
}

function pictograph(g, rl) {
  const rows = g("rows");
  if (!emojiOk(g("keyEmoji")) || !inRange(g("keyEach"), LIMITS.pictoKeyEach)) return null;
  if (!isArr(rows) || !inRange(rows.length, LIMITS.pictoRows)) return null;
  const outRows = [];
  const seen = new Set();
  let total = 0;
  for (const r of rows) {
    if (!isPlainObject(r) || Object.keys(r).some((k) => FORBIDDEN_KEYS.includes(k))) return null;
    const label = labelOk(r.label, LIMITS.label[0], LIMITS.label[1], rl);
    if (label === null || !inRange(r.count, LIMITS.pictoCount)) return null;
    const key = normKey(label);
    if (seen.has(key)) return null;
    seen.add(key);
    total += r.count;
    outRows.push({ label, count: r.count });
  }
  if (total > LIMITS.pictoTotal) return null;
  const out = { kind: "pictograph" };
  if (g("title") !== undefined) { const t = labelOk(g("title"), 1, LIMITS.title, rl); if (t === null) return null; out.title = t; }
  return { ...out, keyEmoji: g("keyEmoji"), keyEach: g("keyEach"), rows: outRows };
}

function thermometer(g) {
  const min = g("min"), max = g("max"), value = g("value");
  if (!inRange(min, LIMITS.thermo) || !inRange(max, LIMITS.thermo) || min >= max || max - min > LIMITS.thermoSpan) return null;
  if (!Number.isInteger(value) || value < min || value > max || !LIMITS.tempUnits.includes(g("tempUnit"))) return null;
  return { kind: "thermometer", min, max, value, tempUnit: g("tempUnit") };
}

// ---- answerCheck ----
const OPS = Object.freeze({
  barChart: ["maxLabel", "minLabel", "valueOf", "sum", "difference"],
  pie: ["shadedCount", "unshadedCount", "partsCount", "shadedFraction"],
  emojiGroup: ["count", "remaining"],
  pictograph: ["maxLabel", "valueOf", "totalValue"],
  clock: ["time"],
  numberLine: ["markValue"],
  thermometer: ["reading"],
  shape: ["perimeter", "sidesCount"],
});
const LABEL_ARGS = Object.freeze({ valueOf: 1, difference: 2 });

const opsFor = (kinds) => [...new Set([].concat(...kinds.map((k) => OPS[k] || [])))];

const labelsOf = (vis) => (vis.kind === "barChart" ? vis.bars : vis.kind === "pictograph" ? vis.rows : []);
const findByLabel = (vis, label) => labelsOf(vis).find((x) => normKey(x.label) === normKey(label));
const valueOfItem = (vis, item) => (vis.kind === "pictograph" ? item.count * vis.keyEach : item.value);

// Normalizes an untrusted answerCheck against its visual. Returns {ok,value}|{ok:false,code:"visual_mismatch"}.
function validateAnswerCheck(ac, vis, allowedOps) {
  const bad = { ok: false, code: "visual_mismatch" };
  if (!isPlainObject(ac) || !vis || !hasOwn(OPS, vis.kind)) return bad;
  if (Object.keys(ac).some((k) => !["op", "label", "label2"].includes(k))) return bad;
  const op = ac.op;
  if (typeof op !== "string" || !OPS[vis.kind].includes(op) || (allowedOps && !allowedOps.includes(op))) return bad;
  const need = LABEL_ARGS[op] || 0;
  const out = { op };
  const given = [ac.label, ac.label2];
  for (let i = 0; i < 2; i++) {
    if (i < need) {
      const t = labelOk(given[i], 1, LIMITS.label[1]);
      if (t === null || !findByLabel(vis, t)) return bad;
      out[i === 0 ? "label" : "label2"] = t;
    } else if (!absent(given[i])) return bad;
  }
  return { ok: true, value: out };
}

// Expected answer from the validated visual. {t:"label"|"int"|"time"|"fraction", ...} or null (undefined or tied).
function computeAnswer(vis, ac) {
  const op = ac.op;
  switch (vis.kind) {
    case "barChart":
    case "pictograph": {
      const items = labelsOf(vis);
      const val = (x) => valueOfItem(vis, x);
      if (op === "maxLabel" || op === "minLabel") {
        const best = op === "maxLabel" ? Math.max(...items.map(val)) : Math.min(...items.map(val));
        const hit = items.filter((x) => val(x) === best);
        return hit.length === 1 ? { t: "label", v: hit[0].label } : null;
      }
      if (op === "valueOf") { const it = findByLabel(vis, ac.label); return it ? { t: "int", v: val(it) } : null; }
      if (op === "sum" || op === "totalValue") return { t: "int", v: items.reduce((a, x) => a + val(x), 0) };
      if (op === "difference") {
        const a = findByLabel(vis, ac.label), b = findByLabel(vis, ac.label2);
        return a && b ? { t: "int", v: Math.abs(val(a) - val(b)) } : null;
      }
      return null;
    }
    case "pie":
      if (op === "shadedCount") return { t: "int", v: vis.shaded };
      if (op === "unshadedCount") return { t: "int", v: vis.parts - vis.shaded };
      if (op === "partsCount") return { t: "int", v: vis.parts };
      if (op === "shadedFraction") return { t: "fraction", n: vis.shaded, d: vis.parts };
      return null;
    case "emojiGroup":
      if (op === "count") return { t: "int", v: vis.count };
      if (op === "remaining") return { t: "int", v: vis.count - (vis.crossed || 0) };
      return null;
    case "clock": return op === "time" ? { t: "time", h: vis.hour, m: vis.minute } : null;
    case "numberLine": return op === "markValue" && vis.marks && vis.marks.length ? { t: "int", v: vis.marks[0] } : null;
    case "thermometer": return op === "reading" ? { t: "int", v: vis.value } : null;
    case "shape":
      if (op === "sidesCount") return { t: "int", v: EDGES[vis.shape] };
      if (op === "perimeter") return vis.sideLabels ? { t: "int", v: vis.sideLabels.reduce((a, n) => a + n, 0) } : null;
      return null;
    default: return null;
  }
}

const words = (s) => " " + s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";

function matchesAnswer(expected, option) {
  if (!expected || typeof option !== "string") return false;
  switch (expected.t) {
    case "label": return normKey(option) === normKey(expected.v) || words(option).includes(words(expected.v));
    case "int": { const m = option.match(/-?\d+/); return !!m && Number(m[0]) === expected.v; }
    case "time": {
      const m = option.match(/(\d{1,2}):(\d{2})/);
      return !!m && Number(m[1]) === expected.h && Number(m[2]) === expected.m;
    }
    case "fraction": {
      const m = option.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) return false;
      const a = Number(m[1]), b = Number(m[2]);
      return b > 0 && a * expected.d === expected.n * b;
    }
    default: return false;
  }
}

// True only when exactly one option matches and it is the stated correct one.
function answerConsistent(vis, ac, options, correctIndex) {
  const expected = computeAnswer(vis, ac);
  if (!expected) return false;
  const hits = [];
  options.forEach((o, i) => { if (matchesAnswer(expected, o)) hits.push(i); });
  return hits.length === 1 && hits[0] === correctIndex;
}

module.exports = {
  LIMITS, KINDS, COMPACT_KINDS, HOSTS, EDGES, EMOJI_DENY, OPS, KEYS, emojiOk, validateVisual, validateAnswerCheck, opsFor,
  computeAnswer, matchesAnswer, answerConsistent, cpLen,
};

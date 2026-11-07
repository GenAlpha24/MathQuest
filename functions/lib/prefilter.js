"use strict";
// Deterministic, network-free prompt checks. Runs before any quota or model spend.

const { PROMPT_MIN, PROMPT_MAX, RAW_PROMPT_CAP } = require("./config");

// Banned stems are stored ROT13-encoded so the repo does not hold plain offensive text.
// Unambiguous terms only (whole-word match); the classifier handles nuance.
const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const BANNED_ENCODED = ("shpx,fuvg,ovgpu,onfgneq,nffubyr,qvpx,phag,cvff,penc,qnza,cbea,kkk,rebgvp,ubeal,oybjwbo," +
  "unaqwbo,znfgheongr,betnfz,encr,encvfg,zbyrfg,avttre,avttn,snttbg,ergneq,genaal,puvax,fcvp,xvxr,jrgonpx," +
  "pbpnvar,urebva,zrgu,zrgunzcurgnzvar,znevwhnan,sragnaly,fhvpvqr,xvyy zlfrys,phg zlfrys,unat zlfrys,tber," +
  "zheqre,znffnper,orurnqvat,gbegher,trabpvqr").split(",");
const BANNED = Object.freeze(BANNED_ENCODED.map(rot13));

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapseAll = (s) => s.replace(/(.)\1+/g, "$1");
const collapseThree = (s) => s.replace(/(.)\1{2,}/g, "$1$1");
const SUFFIX = "(?:s|es|ed|ing|er|ers)?";

function compileBanned(list) {
  return list.map((stem) => {
    const lower = String(stem).toLowerCase().trim();
    const body = lower.split(/\s+/).map(escapeRe).join("\\s+");
    const cbody = collapseAll(lower).split(/\s+/).map(escapeRe).join("\\s+");
    return {
      plain: new RegExp("(?<![a-z0-9])" + body + SUFFIX + "(?![a-z0-9])"),
      // Collapsed form only for stems of 4+ letters, else short stems would hit words like "x".
      collapsed: collapseAll(lower).length >= 4 ? new RegExp("(?<![a-z0-9])" + cbody + collapseAll(SUFFIX) + "(?![a-z0-9])") : null,
    };
  });
}
const DEFAULT_COMPILED = compileBanned(BANNED);

function fold(text) {
  let t = String(text).normalize("NFKC").toLowerCase();
  t = t.replace(/[013457@$!]/g, (c) => LEET[c]);
  return t;
}
// "f u c k" / "f.u.c.k" -> "fuck"
function joinSpaced(t) {
  return t.replace(/(?<![a-z])[a-z](?:[\s.\-_*]+[a-z](?![a-z])){2,}/g, (m) => m.replace(/[\s.\-_*]+/g, ""));
}

function containsBanned(text, banned) {
  const compiled = banned ? compileBanned(banned) : DEFAULT_COMPILED;
  const base = String(text).normalize("NFKC").toLowerCase();
  const folded = fold(text);
  const variants = [base, folded, joinSpaced(base), joinSpaced(folded)];
  for (const v of variants) {
    const three = collapseThree(v);
    const all = collapseAll(v);
    for (const c of compiled) {
      if (c.plain.test(three) || (c.collapsed && c.collapsed.test(all))) return true;
    }
  }
  return false;
}

function sanitizePrompt(raw) {
  let t = String(raw === undefined || raw === null ? "" : raw).slice(0, RAW_PROMPT_CAP).normalize("NFKC");
  t = t.replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\uFE0F]/gu, "");
  t = t.replace(/\p{Extended_Pictographic}/gu, "");
  return t.replace(/\s+/g, " ").trim();
}

const URL_RE = /(https?:|ftp:|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co|edu|gov|ai|app|me|ly|gg|xyz|info|biz|tv)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const HANDLE_RE = /(?:^|[\s(])@\w+/;
const PHONE_RES = [
  /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/,
  /(?<!\d)\+\d{1,3}[\s.-]?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?!\d)/,
  /(?<!\d)\d{10,15}(?!\d)/,
];
const ADDRESS_RE = /\b\d{1,5}\s+(?:[a-z]+\s+){1,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|blvd|boulevard|way)\b/i;
const PERSONAL_RE = /\b(my (?:full |last |real )?name is|my (?:home )?address|my phone|my (?:email|e-mail)|my password|i live (?:at|on)|call me at|text me)\b/i;
const INJECTION_RES = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b.{0,30}\b(instruction|prompt|rule|message|guideline)s?\b/i,
  /\b(system prompt|developer (?:message|mode)|jailbreak|do anything now|dan mode|you are now|new instructions?|reveal your|act as|pretend (?:to be|you)|role-?play)\b/i,
  /<\/?\w+>|`{3}|\[\/?inst\]|<\|[^|]*\|>/i,
];
const UNSAFE_RES = [
  /\bhow (?:to|do (?:i|you)) (?:make|build|get|buy|find|cook|create) (?:a |an |some )?(?:bomb|gun|weapon|poison|drug|explosive|meth)s?\b/i,
  /\b(?:make|build|create) (?:a |an |some )?(?:bomb|gun|weapon|explosive)s?\b/i,
];
const CHARSET_BAD_RE = /[^\p{L}\p{N}\p{M}\s.,!?'’"():;%+\-–/×÷=&$#*]/u;

const hasUrl = (t) => URL_RE.test(t);
const hasContact = (t) => EMAIL_RE.test(t) || HANDLE_RE.test(t) || PHONE_RES.some((r) => r.test(t)) || ADDRESS_RE.test(t);
const hasPersonalInfo = (t) => PERSONAL_RE.test(t);
const hasInjection = (t) => INJECTION_RES.some((r) => r.test(t));
const hasUnsafePhrase = (t) => UNSAFE_RES.some((r) => r.test(t));
const hasBadChars = (t) => CHARSET_BAD_RE.test(t);

// Expects an already sanitized string. Returns {ok:true} or {ok:false, reason}.
function prefilter(sanitized, opts) {
  const t = String(sanitized);
  const banned = opts && opts.banned;
  const len = Array.from(t).length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (len < PROMPT_MIN || letters < 2) return { ok: false, reason: "too_short" };
  if (len > PROMPT_MAX) return { ok: false, reason: "too_long" };
  if (hasUrl(t)) return { ok: false, reason: "url" };
  if (hasContact(t)) return { ok: false, reason: "contact" };
  if (hasPersonalInfo(t)) return { ok: false, reason: "personal_info" };
  if (hasInjection(t)) return { ok: false, reason: "injection" };
  if (containsBanned(t, banned)) return { ok: false, reason: "profanity" };
  if (hasUnsafePhrase(t)) return { ok: false, reason: "unsafe" };
  if (hasBadChars(t)) return { ok: false, reason: "too_vague" };
  return { ok: true };
}

module.exports = {
  BANNED, sanitizePrompt, prefilter, containsBanned,
  hasUrl, hasContact, hasPersonalInfo, hasInjection, hasUnsafePhrase, hasBadChars,
  URL_RE, CHARSET_BAD_RE,
};

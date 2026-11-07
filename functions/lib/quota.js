"use strict";
// Quota + role gate. Admin-SDK Firestore is passed in. All state changes happen in transactions.
//   reserve(): one transaction, gates role/status, daily limits, in-flight lock.
//   finish():  one transaction, saves the game (or records an outcome) and updates counters.

const { HttpsError } = require("firebase-functions/v2/https");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const cfg = require("./config");

const DAY_MS = 86400000;
const ROLES = ["student", "teacher", "parent"];

function dayKey(now) {
  const d = new Date(now);
  return String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}
const ts = (ms) => Timestamp.fromMillis(ms);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const deny = (code, detail, msg) => new HttpsError(code, msg, { code: detail });

function refs(db, uid, day) {
  return {
    user: db.collection("users").doc(uid),
    usage: db.collection("usage").doc(uid + "_" + day),
    global: db.collection("usage").doc("global_" + day),
  };
}

// Returns a context object that finish() needs. Throws HttpsError on any gate failure.
async function reserve(db, uid, now) {
  const nowMs = now.getTime();
  const day = dayKey(nowMs);
  const r = refs(db, uid, day);
  return db.runTransaction(async (tx) => {
    const [userSnap, usageSnap, globalSnap] = await Promise.all([tx.get(r.user), tx.get(r.usage), tx.get(r.global)]);
    const profile = userSnap.exists ? userSnap.data() : null;
    if (!profile || !ROLES.includes(profile.role)) throw deny("permission-denied", "profile", "Profile not ready.");
    if (profile.role === "student" && profile.status !== "active") throw deny("permission-denied", "pending", "Not linked yet.");

    const limit = profile.role === "student" ? cfg.limits.STUDENT_DAILY : cfg.limits.ADULT_DAILY;
    const u = usageSnap.exists ? usageSnap.data() : {};
    const g = globalSnap.exists ? globalSnap.data() : {};
    const lockMs = u.lockUntil && typeof u.lockUntil.toMillis === "function" ? u.lockUntil.toMillis() : 0;
    if (lockMs > nowMs) throw deny("resource-exhausted", "busy", "Still building.");
    if (num(u.requests) >= limit) throw deny("resource-exhausted", "daily_quota", "Daily limit reached.");
    if (num(g.requests) >= cfg.GLOBAL_DAILY_CAP) throw deny("resource-exhausted", "global_cap", "Busy today.");

    const expireAt = ts((Math.floor(nowMs / DAY_MS) + 1) * DAY_MS + cfg.USAGE_RETENTION_DAYS * DAY_MS);
    const requests = num(u.requests) + 1;
    tx.set(r.usage, {
      uid, day, requests, games: num(u.games), refusals: num(u.refusals), failures: num(u.failures),
      refunds: num(u.refunds), lockUntil: ts(nowMs + cfg.limits.LOCK_SECONDS * 1000), expireAt,
    });
    tx.set(r.global, { day, requests: num(g.requests) + 1, expireAt });
    const rawGrade = Number(profile.grade);
    return {
      uid, day, limit, role: profile.role, expireAt,
      grade: Number.isInteger(rawGrade) && cfg.GRADES.includes(rawGrade) ? rawGrade : 1,
      remaining: limit - requests,
    };
  });
}

// ctx from reserve(). result: {game} | {outcome:"refused"} | {outcome:"failure", refund:true}
// game = full doc fields except createdAt/expireAt (added here). Returns {gameId?, remaining}.
async function finish(db, ctx, now, result) {
  const nowMs = now.getTime();
  const r = refs(db, ctx.uid, ctx.day);
  return db.runTransaction(async (tx) => {
    const usageSnap = await tx.get(r.usage);
    const u = usageSnap.exists ? usageSnap.data() : {};
    const upd = { lockUntil: null };
    let requests = num(u.requests);
    let gameId;
    if (result.game) {
      const ref = db.collection("games").doc();
      gameId = ref.id;
      tx.create(ref, {
        ...result.game,
        createdAt: FieldValue.serverTimestamp(),
        expireAt: ts(nowMs + cfg.GAME_RETENTION_DAYS * DAY_MS),
      });
      upd.games = num(u.games) + 1;
    } else if (result.outcome === "refused") {
      upd.refusals = num(u.refusals) + 1;
    } else {
      upd.failures = num(u.failures) + 1;
      if (result.refund && num(u.refunds) < cfg.limits.REFUND_CAP && requests > 0) {
        requests -= 1; // user counter only; the global counter is never refunded
        upd.requests = requests;
        upd.refunds = num(u.refunds) + 1;
      }
    }
    tx.set(r.usage, upd, { merge: true });
    return { gameId, remaining: Math.max(0, ctx.limit - requests) };
  });
}

module.exports = { reserve, finish, dayKey };

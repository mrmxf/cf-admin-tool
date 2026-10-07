/**
 * Login: allowlisted email -> code by email -> code by ntfy -> session.
 *
 *   startLogin       an email was typed in. ALWAYS makes a challenge; only an
 *                    allowlisted address, under its rate limit, gets a code.
 *   resendNtfyCode   a new phone code for a challenge at the ntfy stage.
 *   verifyCode       checks the code for the challenge's current stage.
 *                    email stage ok -> SECOND FACTOR ON:  the ntfy stage, new code
 *                                      SECOND FACTOR OFF: a session, straight away
 *                    ntfy stage ok  -> deletes the challenge, issues a session.
 *
 * ── THE SECOND FACTOR GATE ────────────────────────────────────────────────────
 * `secondFactor` (config.requireSecondFactor, default true) is the ONE switch.
 * Off, the ntfy stage is never entered: no push, no topic needed, and a login
 * is the emailed code alone. Everything the second factor does sits inside
 * `if (secondFactor) {...}` blocks here and in handler.js, so replacing ntfy
 * with another channel (TOTP, Signal, Telegram) changes only those blocks.
 *   getSession       the signed-in user for a session cookie, or null.
 *   endSession       logout.
 *
 * ── SILENT IGNORE ─────────────────────────────────────────────────────────────
 * An address not on the allowlist gets exactly what an allowlisted one gets: a
 * challenge row, a cookie, the "enter your code" page, and "that code is not
 * right" for every guess. Its code hash is "", which nothing hashes to. The
 * code itself is delivered by the CALLER in ctx.waitUntil, after the response,
 * so the response time does not depend on whether an email was sent.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────────
 * ADMIN_DB (db/migrations). D1 is strongly consistent, so the attempt counter
 * really does cap guesses: it is incremented atomically BEFORE the comparison.
 * Codes and session tokens are stored only as SHA-256 hashes.
 *
 * Rate limits are keyed by a HASH of the address, never the address: every
 * address typed in is counted (see startLogin), so the table must not become a
 * list of what strangers typed. Rows older than a day are deleted as we go.
 *
 * ── GUESSING ──────────────────────────────────────────────────────────────────
 * A code is 6 digits. Each challenge allows MAX_ATTEMPTS guesses, and an
 * address gets at most SEND_DAILY_LIMIT real codes and FAIL_DAILY_LIMIT wrong
 * guesses a day, so an attacker who can pass Turnstile at will gets at most
 * FAIL_DAILY_LIMIT guesses a day at one address: about 1 in 50,000 per day.
 * The price is that the same attacker can use up an address's daily budget and
 * lock its owner out until the day is up. With requireSecondFactor off, this
 * cap is the only thing between a guesser and a session.
 *
 * Every function takes `now` (Unix seconds) so the tests can move the clock.
 */

export const CODE_TTL_S = 10 * 60;         // an email-stage challenge
export const NTFY_TTL_S = 5 * 60;          // the ntfy stage, from when its code is sent
export const MAX_ATTEMPTS = 5;             // per stage; then the challenge is burned
export const SESSION_TTL_S = 18 * 60 * 60; // absolute: a long waking day
export const SESSION_IDLE_S = 3 * 60 * 60; // since last request: a lunch break and two calls
export const SEND_LIMIT = 3;               // codes emailed per address per window
export const SEND_WINDOW_S = 15 * 60;
export const SEND_DAILY_LIMIT = 10;        // ...and per address per day
export const FAIL_DAILY_LIMIT = 20;        // wrong codes per address per day; then every
                                           // challenge for it is burned until the day is up
export const DAY_S = 24 * 60 * 60;
export const NTFY_RESENDS = 3;             // new phone codes per challenge

const TOUCH_EVERY_S = 60;                  // last_seen writes at most once a minute
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export const nowS = () => Math.floor(Date.now() / 1000);

/**
 * Session lifetimes, from the optional ADMIN_SESSION_TTL_S / ADMIN_SESSION_IDLE_S
 * vars. A missing value takes the default; a value that is not a whole number of
 * seconds > 0 also takes the default, with a log line.
 * @returns {{ttl: number, idle: number}}
 */
export function sessionLimits(env = {}) {
  const pick = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    console.log(`[admin] ${name}=${JSON.stringify(raw)} is not a whole number of seconds > 0 - using ${fallback}`);
    return fallback;
  };
  return { ttl: pick("ADMIN_SESSION_TTL_S", SESSION_TTL_S), idle: pick("ADMIN_SESSION_IDLE_S", SESSION_IDLE_S) };
}

const DEFAULT_LIMITS = { ttl: SESSION_TTL_S, idle: SESSION_IDLE_S };

export const normaliseEmail = (s) => String(s ?? "").trim().toLowerCase();

/**
 * ADMIN_USERS -> Map(email -> {email, ntfyTopic}). Anything malformed makes the
 * whole list empty: fail closed, nobody can log in, and `error` says why.
 *
 *   [{"email": "a@example.com", "ntfyTopic": "long-unguessable-topic"}]
 *
 * ntfyTopic is optional: only the second factor needs it, and a user without
 * one cannot pass the second factor while it is on (verifyCode fails closed).
 */
export function parseUsers(json) {
  const users = new Map();
  if (!json) return { users, error: "ADMIN_USERS is not set" };
  let list;
  try { list = JSON.parse(json); } catch { return { users, error: "ADMIN_USERS is not valid JSON" }; }
  if (!Array.isArray(list)) return { users, error: "ADMIN_USERS is not a JSON array" };
  for (const u of list) {
    const email = normaliseEmail(u?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { users: new Map(), error: "ADMIN_USERS has an entry with no valid email" };
    if (u?.ntfyTopic != null && !NTFY_TOPIC.test(u.ntfyTopic)) {
      return { users: new Map(), error: `ADMIN_USERS entry for ${email} has an invalid ntfyTopic` };
    }
    users.set(email, { email, ntfyTopic: u?.ntfyTopic ?? null });
  }
  return { users, error: users.size ? null : "ADMIN_USERS is empty" };
}

// ── crypto ──────────────────────────────────────────────────────────────────────

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randomToken(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Six digits, uniform: rejection-sample away the modulo bias. */
export function sixDigits() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

export async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time for equal lengths; unequal lengths are not a secret here. */
function sameHex(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Salted with the challenge id and stage: an email code cannot be replayed at
// the ntfy stage, nor one challenge's code at another.
const codeHash = (id, stage, code) => sha256(`${id}:${stage}:${code}`);

/** "123 456" and "123456" are the same code; anything else is not a code. */
export const cleanCode = (s) => String(s ?? "").replace(/\s+/g, "");

// ── rate limit ────────────────────────────────────────────────────────────────

const rateKey = async (kind, email) => `${kind}:${await sha256(`rate:${email}`)}`;

/** Count one event against `key`; true if it is within `limit` for the window. */
async function underLimit(db, key, limit, windowS, now) {
  const row = await db.prepare(
    `INSERT INTO rate (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count        = CASE WHEN rate.window_start <= ? THEN 1 ELSE rate.count + 1 END,
       window_start = CASE WHEN rate.window_start <= ? THEN excluded.window_start ELSE rate.window_start END
     RETURNING count`,
  ).bind(key, now, now - windowS, now - windowS).first();
  return row.count <= limit;
}

// ── the flow ──────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{challengeId: string, deliver: null | {email: string, code: string}}>}
 *   deliver is non-null only for an allowlisted address under its limits. The
 *   caller emails it in ctx.waitUntil and never tells the visitor either way.
 *
 * The same work is done for EVERY address - both limits counted, a code made
 * and hashed - so the response time does not say whether it is on the list.
 */
export async function startLogin({ db, users, email, now = nowS() }) {
  email = normaliseEmail(email);
  await db.batch([
    db.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM rate WHERE window_start < ?").bind(now - DAY_S),
  ]);

  const id = randomToken(16);
  const code = sixDigits();
  const codeHashed = await codeHash(id, "email", code);
  const inWindow = await underLimit(db, await rateKey("send", email), SEND_LIMIT, SEND_WINDOW_S, now);
  const inDay = await underLimit(db, await rateKey("sendday", email), SEND_DAILY_LIMIT, DAY_S, now);
  let hash = "";
  let deliver = null;
  if (users.has(email) && inWindow && inDay) {
    hash = codeHashed;
    deliver = { email, code };
  }
  await db.prepare(
    "INSERT INTO challenges (id, email, stage, code_hash, attempts, created_at, expires_at) VALUES (?, ?, 'email', ?, 0, ?, ?)",
  ).bind(id, email, hash, now, now + CODE_TTL_S).run();
  return { challengeId: id, deliver };
}

/** The stage a challenge is at ("email" | "ntfy"), or null if it is gone or expired. */
export async function challengeStage({ db, challengeId, now = nowS() }) {
  if (!challengeId) return null;
  const row = await db.prepare("SELECT stage FROM challenges WHERE id = ? AND expires_at >= ?")
    .bind(challengeId, now).first();
  return row?.stage ?? null;
}

/**
 * @returns {Promise<
 *   {ok: false, reason: "no-challenge" | "burned" | "wrong-code", attemptsLeft?: number} |
 *   {ok: true, stage: "email", ntfy: {topic: string, code: string}} |     second factor ON
 *   {ok: true, stage: string, session: {token: string, email: string, maxAge: number}}
 * >}
 */
export async function verifyCode({ db, users, challengeId, code, secondFactor = true, limits = DEFAULT_LIMITS, now = nowS() }) {
  if (!challengeId) return { ok: false, reason: "no-challenge" };

  // Count the attempt first, atomically: parallel guesses cannot share one.
  const row = await db.prepare(
    `UPDATE challenges SET attempts = attempts + 1
     WHERE id = ? AND expires_at >= ?
     RETURNING email, stage, code_hash AS codeHash, attempts`,
  ).bind(challengeId, now).first();
  if (!row) return { ok: false, reason: "no-challenge" };
  if (row.attempts > MAX_ATTEMPTS) {
    await db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId).run();
    return { ok: false, reason: "burned" };
  }

  // An address that has used up its wrong guesses for the day gets no more
  // comparisons at all, right or wrong: checked BEFORE the code is looked at.
  const failKey = await rateKey("fail", row.email);
  const fails = await db.prepare("SELECT count FROM rate WHERE key = ? AND window_start > ?")
    .bind(failKey, now - DAY_S).first();
  if ((fails?.count ?? 0) >= FAIL_DAILY_LIMIT) {
    await db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId).run();
    return { ok: false, reason: "burned" };
  }

  const given = cleanCode(code);
  const good = /^\d{6}$/.test(given) && sameHex(await codeHash(challengeId, row.stage, given), row.codeHash);
  if (!good) {
    const attemptsLeft = MAX_ATTEMPTS - row.attempts;
    await underLimit(db, failKey, FAIL_DAILY_LIMIT, DAY_S, now);
    if (attemptsLeft <= 0) {
      await db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId).run();
      return { ok: false, reason: "burned" };
    }
    return { ok: false, reason: "wrong-code", attemptsLeft };
  }

  // Re-read the allowlist at every step: removing someone takes effect mid-login.
  const user = users.get(row.email);
  if (!user) {
    await db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId).run();
    return { ok: false, reason: "burned" };
  }

  if (secondFactor) {
    if (row.stage === "email") {
      // No topic, no second factor: fail closed rather than skip it.
      if (!user.ntfyTopic) {
        await db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId).run();
        return { ok: false, reason: "burned" };
      }
      const ntfyCode = sixDigits();
      await db.prepare(
        "UPDATE challenges SET stage = 'ntfy', code_hash = ?, attempts = 0, expires_at = ? WHERE id = ?",
      ).bind(await codeHash(challengeId, "ntfy", ntfyCode), now + NTFY_TTL_S, challengeId).run();
      return { ok: true, stage: "email", ntfy: { topic: user.ntfyTopic, code: ntfyCode } };
    }
  }

  return { ok: true, stage: row.stage, session: await issueSession({ db, challengeId, email: row.email, limits, now }) };
}

/** Swap a passed challenge for a session. Only the token's hash is stored. */
async function issueSession({ db, challengeId, email, limits, now }) {
  const token = randomToken(32);
  await db.batch([
    db.prepare("DELETE FROM challenges WHERE id = ?").bind(challengeId),
    db.prepare("INSERT INTO sessions (id_hash, email, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256(token), email, now, now + limits.ttl, now),
  ]);
  return { token, email, maxAge: limits.ttl };
}

/**
 * A new phone code, replacing the last one, for a challenge at the ntfy stage.
 * Attempts are NOT reset: a resend is for a code that never arrived, not a way
 * to buy more guesses. At most NTFY_RESENDS per challenge.
 *
 * @returns {Promise<{ok: false, reason: "no-challenge" | "limit"} |
 *                   {ok: true, ntfy: {topic: string, code: string}}>}
 */
export async function resendNtfyCode({ db, users, challengeId, now = nowS() }) {
  if (!challengeId) return { ok: false, reason: "no-challenge" };
  const row = await db.prepare(
    "SELECT email FROM challenges WHERE id = ? AND stage = 'ntfy' AND expires_at >= ?",
  ).bind(challengeId, now).first();
  const user = row && users.get(row.email);
  if (!user) return { ok: false, reason: "no-challenge" };
  if (!await underLimit(db, `resend:${challengeId}`, NTFY_RESENDS, CODE_TTL_S, now)) {
    return { ok: false, reason: "limit" };
  }
  const code = sixDigits();
  await db.prepare("UPDATE challenges SET code_hash = ?, expires_at = ? WHERE id = ?")
    .bind(await codeHash(challengeId, "ntfy", code), now + NTFY_TTL_S, challengeId).run();
  return { ok: true, ntfy: { topic: user.ntfyTopic, code } };
}

/** @returns {Promise<null | {email: string}>} */
export async function getSession({ db, users, token, limits = DEFAULT_LIMITS, now = nowS() }) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const idHash = await sha256(token);
  const row = await db.prepare(
    "SELECT email, expires_at AS expiresAt, last_seen AS lastSeen FROM sessions WHERE id_hash = ?",
  ).bind(idHash).first();
  if (!row) return null;
  // Expired, idle, or taken off the allowlist since signing in.
  if (row.expiresAt < now || row.lastSeen + limits.idle < now || !users.has(row.email)) {
    await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  if (now - row.lastSeen >= TOUCH_EVERY_S) {
    await db.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").bind(now, idHash).run();
  }
  return { email: row.email };
}

export async function endSession({ db, token }) {
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
}

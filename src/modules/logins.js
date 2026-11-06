/**
 * The sign-in log (ADMIN_DB auth_events, migration 0006): every step of every
 * sign-in attempt, per origin, shown at <root>/logins behind the core's tile.
 *
 * ONE ATTEMPT = one challenge (the code sent to one address). Its rows share
 * `attempt`, a sha256 of the challenge id - never the id, which is a live
 * cookie. A session remembers its attempt, so signing out joins the same group.
 * A Turnstile refusal has no challenge: it is an attempt of one row.
 *
 * WHO: the address if it is on the allowlist, else masked (maskEmail), so the
 * log keeps no stranger's full address. No IP address, ever.
 *
 * WRITING NEVER BREAKS SIGN-IN: a failed write is logged to the console and
 * forgotten. Each write is the same INSERT whether or not the address is on
 * the list, so the log adds no timing difference.
 *
 * Rows older than RETAIN_S are deleted (pruneLog) at each new attempt.
 */
import { sha256, attemptOf } from "../auth.js";

export { attemptOf };

export const RETAIN_S = 90 * 24 * 3600;
export const PAGE = 10;

/** What each step means, for the page. Anything else shows as its name. */
export const STEPS = {
  "turnstile-refused": "❌ anti-spam check failed",
  "code-requested": "📨 code requested",
  "code-emailed": "✉️ code emailed",
  "code-not-sent": "‼️ code email not sent",
  "wrong-code": "❌ wrong code",
  "refused": "⛔ refused",
  "expired": "⌛ expired or used up",
  "phone-code-sent": "📱 phone code sent",
  "phone-code-not-sent": "‼️ phone code not sent",
  "signed-in": "✅ signed in",
  "signed-out": "👋 signed out",
};

/** "jo@example.org" -> "j***@e***.org". Not reversible; enough to spot a typo or a probe. */
export function maskEmail(email) {
  const s = String(email ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? `${s[0]}***` : "(none)";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${host ? `${host[0]}***` : ""}${tld}`.slice(0, 80);
}

/** The log's name for an address: itself if allowlisted, else masked. */
export const whoFor = (users, email) => {
  const e = String(email ?? "").trim().toLowerCase();
  return users?.has?.(e) ? e : `${maskEmail(e)} (not on the list)`;
};

/** Append one step. Never throws. */
export async function logStep(db, { origin, attempt, who = "", step, detail = "", now = Math.floor(Date.now() / 1000) }) {
  try {
    await db.prepare("INSERT INTO auth_events (origin, attempt, who, step, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(String(origin), String(attempt || await sha256(`lone:${crypto.randomUUID()}`)), String(who).slice(0, 254),
        String(step).slice(0, 40), String(detail ?? "").slice(0, 300), now).run();
  } catch (err) {
    console.log(`[admin] sign-in log not written (${step}): ${err.message}`);
  }
}

/** Forget rows older than RETAIN_S, every origin. Never throws. */
export async function pruneLog(db, now = Math.floor(Date.now() / 1000)) {
  try {
    await db.prepare("DELETE FROM auth_events WHERE created_at < ?").bind(now - RETAIN_S).run();
  } catch (err) {
    console.log(`[admin] sign-in log not pruned: ${err.message}`);
  }
}

/**
 * Attempts on this origin, newest first: PAGE of them, each with every step in
 * order. `before` is the paging cursor (the first row id of the last attempt
 * shown); `next` is the cursor for the page after, or null.
 * @returns {Promise<{attempts: Array<{attempt, first, who, steps: Array<{step, detail, at}>}>, next: number | null}>}
 */
export async function listAttempts(db, { origin, before = null, limit = PAGE }) {
  const cap = Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
  const { results: heads } = await db.prepare(
    `SELECT attempt, MIN(id) AS first FROM auth_events WHERE origin = ?
     GROUP BY attempt HAVING MIN(id) < ? ORDER BY first DESC LIMIT ?`,
  ).bind(origin, cap, limit + 1).all();
  const shown = heads.slice(0, limit);
  if (!shown.length) return { attempts: [], next: null };
  const { results: rows } = await db.prepare(
    `SELECT id, attempt, who, step, detail, created_at AS at FROM auth_events
     WHERE origin = ? AND attempt IN (${shown.map(() => "?").join(", ")}) ORDER BY id`,
  ).bind(origin, ...shown.map((h) => h.attempt)).all();
  const attempts = shown.map((h) => {
    const steps = rows.filter((r) => r.attempt === h.attempt);
    return { attempt: h.attempt, first: h.first, who: steps.find((s) => s.who)?.who ?? "", steps };
  });
  return { attempts, next: heads.length > limit ? shown.at(-1).first : null };
}

/** The 24-hour counts and the latest attempt, for the tile. */
export async function loginSummary(db, { origin, now = Math.floor(Date.now() / 1000) }) {
  const day = await db.prepare(
    `SELECT SUM(step = 'signed-in') AS ok, SUM(step IN ('turnstile-refused', 'wrong-code', 'refused')) AS bad
     FROM auth_events WHERE origin = ? AND created_at > ?`,
  ).bind(origin, now - 24 * 3600).first();
  const { attempts } = await listAttempts(db, { origin, limit: 1 });
  return { ok: day?.ok ?? 0, bad: day?.bad ?? 0, latest: attempts[0] ?? null };
}

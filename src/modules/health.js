/**
 * Health checks for the dashboard and for the public GET <root>/health.
 *
 * Each check is {name, ok: true | false | null, detail}. null means "could not
 * tell", e.g. a form Worker that is not bound in local development - shown as
 * unknown, not as a failure.
 *
 * The core checks sign-in's own needs; each plugin adds its own through
 * health() (dashboard) and flags() (public). The public /health gets flags
 * only: never an address, a topic or a count.
 */

import { parseUsers } from "../auth.js";

const FORM_HEALTH_TIMEOUT_MS = 3000;

export async function dbPing(db, sql) {
  if (!db) return { ok: false, detail: "not bound" };
  try {
    await db.prepare(sql).first();
    return { ok: true, detail: "reachable" };
  } catch (err) {
    return { ok: false, detail: `error: ${err.message}` };
  }
}

/** A form Worker's own /health, through its service binding. */
export async function formHealth(env, form, origin) {
  const svc = form.service && env[form.service];
  if (!svc) return { ok: null, detail: "not bound" };
  try {
    const res = await svc.fetch(new Request(`${origin}${form.path}/health`), {
      signal: AbortSignal.timeout(FORM_HEALTH_TIMEOUT_MS),
    });
    // Not JSON: something other than the form answered (e.g. wrangler dev's 503
    // for a binding whose Worker is not running) - can't tell, not a failure.
    if (!(res.headers.get("content-type") || "").includes("json")) {
      return { ok: null, detail: `unreachable: HTTP ${res.status}` };
    }
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const h = await res.json();
    const flags = ["mailtrapConfigured", "senderConfigured", "recipientConfigured",
      "turnstileConfigured", "storeConfigured"];
    const missing = flags.filter((f) => h[f] !== true);
    if (h.dryRun) missing.push("dryRun is ON - no email is being sent");
    return { ok: missing.length === 0, detail: missing.length ? `not ok: ${missing.join(", ")}` : "all configured" };
  } catch (err) {
    return { ok: null, detail: `unreachable: ${err.message}` };
  }
}

/** The core's flags for the public /health endpoint. */
export async function coreFlags(env, { secondFactor = true } = {}) {
  const { users } = parseUsers(env.ADMIN_USERS);
  return {
    adminDb: (await dbPing(env.ADMIN_DB, "SELECT 1 FROM sessions LIMIT 1")).ok,
    usersConfigured: users.size > 0,
    mailConfigured: Boolean(env.MAILTRAP_API_TOKEN && env.ADMIN_SENDER),
    turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
    dryRun: env.DRY_RUN === "true",
    secondFactor,
  };
}

/** The core's checks, in words, for the signed-in dashboard. */
export async function coreChecks(env, { secondFactor = true } = {}) {
  const { users, error } = parseUsers(env.ADMIN_USERS);
  return [
    { name: "Admin database (ADMIN_DB)", ...await dbPing(env.ADMIN_DB, "SELECT 1 FROM sessions LIMIT 1") },
    { name: "Admin users", ok: users.size > 0, detail: error ?? `${users.size} on the allowlist` },
    {
      name: "Login email (Mailtrap)",
      ok: env.DRY_RUN === "true" ? null : Boolean(env.MAILTRAP_API_TOKEN && env.ADMIN_SENDER),
      detail: env.DRY_RUN === "true" ? "dry run - codes printed to the console" : (env.ADMIN_SENDER || "ADMIN_SENDER missing"),
    },
    secondFactor === false
      ? { name: "Second factor (ntfy)", ok: null, detail: "OFF - sign-in is the emailed code alone (requireSecondFactor: false)" }
      : {
        name: "Second factor (ntfy)",
        ok: env.DRY_RUN === "true" ? null : true,
        detail: env.DRY_RUN === "true" ? "dry run - codes printed to the console" : (env.NTFY_SERVER || "https://ntfy.sh"),
      },
    { name: "Turnstile", ok: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY), detail: env.TURNSTILE_SECRET_KEY ? "configured" : "TURNSTILE_SECRET_KEY missing" },
  ];
}

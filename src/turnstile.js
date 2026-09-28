/**
 * Turnstile on the email step, so a script cannot use the login form to make
 * us email the allowlist. Fails closed: no secret means no login.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `hostname` is the host the form was served on. A token solved on another
 * host is refused, as Cloudflare advises: a widget's sitekey is public, so
 * without this a token farmed on a page elsewhere would pass here. Skipped on
 * localhost, where Cloudflare's test keys answer with a made-up hostname.
 */
export async function verifyTurnstile(token, secret, hostname = "") {
  if (!secret) return { ok: false, reason: "turnstile-not-configured" };
  if (!token) return { ok: false, reason: "missing-input-response" };
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  try {
    const result = await (await fetch(VERIFY_URL, { method: "POST", body })).json();
    if (!result.success) return { ok: false, reason: (result["error-codes"] || []).join(", ") || "rejected" };
    if (hostname && !LOCAL.has(hostname) && result.hostname !== hostname) {
      return { ok: false, reason: `hostname-mismatch: ${result.hostname}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verify-request-failed: ${err.message}` };
  }
}

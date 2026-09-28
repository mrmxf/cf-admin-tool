/**
 * Getting a login code to a person: by email (Mailtrap) and by push (ntfy).
 *
 * Both are called from ctx.waitUntil, after the response has gone, so a slow
 * or failed send cannot change what the visitor sees or how long it takes.
 * Failures are logged, never shown.
 *
 * Nothing a visitor typed reaches a header here: the recipient is the
 * allowlisted address (matched exactly, so it is ours), and the subject, title
 * and sender name come from config.
 *
 * DRY RUN (local development only): the code is printed to the console instead
 * of sent. isLocalDev() requires DRY_RUN=true AND a localhost URL, the same
 * rule as cf-form-mailer's reader bypass. A deploy forces DRY_RUN=false; a
 * dry run that somehow reached the live site prints nothing and sends nothing.
 */

const MAILTRAP_URL = "https://send.api.mailtrap.io/api/send";
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const NTFY_TIMEOUT_MS = 8000;

export function isLocalDev(request, env) {
  const host = new URL(request.url).hostname;
  return env.DRY_RUN === "true" && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
}

/** Strip anything that would end a header line. Config values, but still. */
const headerSafe = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export async function sendEmailCode({ env, site, request, to, code, minutes, secondFactor = true }) {
  if (env.DRY_RUN === "true") {
    if (isLocalDev(request, env)) console.log(`[admin] DRY RUN email code for ${to}: ${code}`);
    else console.log("[admin] DRY RUN on a non-local host: email code NOT delivered");
    return;
  }
  if (!env.MAILTRAP_API_TOKEN || !env.ADMIN_SENDER) {
    console.log("[admin] email code NOT sent: MAILTRAP_API_TOKEN or ADMIN_SENDER missing");
    return;
  }
  const origin = new URL(request.url).origin;
  const res = await fetch(MAILTRAP_URL, {
    method: "POST",
    headers: { "Api-Token": env.MAILTRAP_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({
      from: { email: env.ADMIN_SENDER, name: headerSafe(`${site.name} admin`) },
      to: [{ email: to }],
      subject: headerSafe(`${site.name} admin login code`),
      category: "admin-login",
      text:
        `Your ${site.name} admin login code is:\n\n    ${code}\n\n` +
        `It expires in ${minutes} minutes.` +
        (secondFactor ? ` After this you will be asked for a second\ncode, sent to the ntfy app on your phone.` : "") + `\n\n` +
        `If you did not just try to log in at ${origin}, ignore this email.\n`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(`[admin] email code NOT sent: mailtrap ${res.status} ${detail.slice(0, 200)}`);
  }
}

/**
 * Unlike the email code, this one is AWAITED, and its result is shown. By the
 * ntfy stage the person has proved they own an allowlisted address, so saying
 * "your phone code could not be sent" gives nothing away - and a silent failure
 * leaves them staring at "check your phone" for a code that is never coming.
 *
 * NOTE ntfy.sh rate-limits by IP unless the account has a paid tier (its
 * /v1/account says limits.basis "ip" or "tier"). Workers share egress IPs, so a
 * free ntfy.sh account can answer 429. A token alone does not change that.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function sendNtfyCode({ env, site, request, topic, code, minutes }) {
  if (env.DRY_RUN === "true") {
    if (isLocalDev(request, env)) {
      console.log(`[admin] DRY RUN ntfy code for topic ${topic}: ${code}`);
      return { ok: true };
    }
    console.log("[admin] DRY RUN on a non-local host: ntfy code NOT delivered");
    return { ok: false, reason: "dry run on a non-local host" };
  }
  const server = (env.NTFY_SERVER || DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
  const headers = {
    Title: headerSafe(`${site.name} admin login`),
    Priority: "high",
    Tags: "key",
  };
  // Optional: an ntfy account's access token. Needed for a self-hosted server
  // with access control; on ntfy.sh it only lifts the IP rate limit on a paid tier.
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  let res;
  try {
    res = await fetch(`${server}/${topic}`, {
      method: "POST",
      headers,
      body: `Login code: ${code}\nExpires in ${minutes} minutes.`,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
  } catch (err) {
    console.log(`[admin] ntfy code NOT sent: ${err.message}`);
    return { ok: false, reason: `no answer from ${new URL(server).host}` };
  }
  if (!res.ok) {
    // ntfy's JSON error names the exact limit (e.g. 42901 vs 42908); log it.
    const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    console.log(`[admin] ntfy code NOT sent: ${res.status} token=${env.NTFY_TOKEN ? "yes" : "no"} ${detail}`);
    let said = "";
    try { said = JSON.parse(detail).error || ""; } catch { /* not ntfy's JSON */ }
    return { ok: false, reason: `${new URL(server).host} answered ${res.status}${said ? `: ${said}` : ""}` };
  }
  console.log(`[admin] ntfy code sent token=${env.NTFY_TOKEN ? "yes" : "no"}`);
  return { ok: true };
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * One email for a workflow (a response to a submitter), AWAITED and FAIL
 * CLOSED: the caller logs "with mail" only on {ok: true}. `to` came from a
 * form, so it is checked for shape and stripped of line breaks like everything
 * else that reaches a header.
 *
 * DRY RUN: printed in full on localhost and reported as sent; on any other host
 * nothing is printed and it reports NOT sent.
 *
 * @returns {Promise<{ok: true, dryRun?: true} | {ok: false, reason: string}>}
 */
export async function sendMail({ env, request, from, fromName, to, replyTo, subject, text, html, category }) {
  to = headerSafe(to);
  if (!EMAIL.test(to)) return { ok: false, reason: "the submitter's email address does not look right" };
  const payload = {
    from: { email: headerSafe(from), name: headerSafe(fromName) },
    to: [{ email: to }],
    subject: headerSafe(subject),
    text,
    html,
    category: headerSafe(category || "admin-workflow"),
  };
  if (replyTo && EMAIL.test(headerSafe(replyTo))) payload.headers = { "Reply-To": headerSafe(replyTo) };
  if (env.DRY_RUN === "true") {
    if (!isLocalDev(request, env)) {
      console.log("[admin] DRY RUN on a non-local host: workflow email NOT sent");
      return { ok: false, reason: "dry run on a non-local host" };
    }
    console.log(`[admin] DRY RUN workflow email\nTo: ${to}\nFrom: ${payload.from.name} <${payload.from.email}>\n` +
      `Reply-To: ${payload.headers?.["Reply-To"] ?? ""}\nSubject: ${payload.subject}\n\n${text}\n`);
    return { ok: true, dryRun: true };
  }
  if (!env.MAILTRAP_API_TOKEN || !payload.from.email) return { ok: false, reason: "mail is not configured" };
  try {
    const res = await fetch(MAILTRAP_URL, {
      method: "POST",
      headers: { "Api-Token": env.MAILTRAP_API_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => "");
    console.log(`[admin] workflow email NOT sent: mailtrap ${res.status} ${detail.slice(0, 200)}`);
    return { ok: false, reason: `the mail service answered ${res.status}` };
  } catch (err) {
    console.log(`[admin] workflow email NOT sent: ${err.message}`);
    return { ok: false, reason: "the mail service could not be reached" };
  }
}

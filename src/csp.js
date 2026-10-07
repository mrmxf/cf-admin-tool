/**
 * The admin's Content-Security-Policy. No script of ours runs on an admin page,
 * except a workflow page's own `scripts` (workflows.js), each allowed by the
 * sha256 of its exact text: an injected <script> in a public answer never runs.
 * A <script src> from the admin cannot work at all - the core's Fetch Metadata
 * check refuses every subresource request to an admin URL - so inline, by hash,
 * is the only way, and it opens nothing else.
 */

const directives = (scriptSrc) => [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  `script-src ${scriptSrc}`,
  "frame-src https://challenges.cloudflare.com",
  "connect-src https://challenges.cloudflare.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TURNSTILE = "https://challenges.cloudflare.com";

export const CSP = directives(TURNSTILE);

/** 'sha256-<base64>' of a script's exact text, as CSP wants it. */
export async function scriptHash(source) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** The CSP with these scripts' hashes allowed, and nothing else changed. */
export async function cspWithScripts(sources) {
  const hashes = await Promise.all(sources.map(scriptHash));
  return directives([...hashes, TURNSTILE].join(" "));
}

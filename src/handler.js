/**
 * createAdmin(config) -> a Worker ({fetch}) serving the admin area under
 * config.root (default /admin; the ADMIN_ROOT var overrides it).
 *
 * The core is sign-in, the page layout, the dashboard and a router. Everything
 * else is a PLUGIN: a Worker-shaped object mounted at one path segment.
 *
 *   GET  <root>/health             public JSON flags, no detail
 *   GET  <root>/login              step 0: email (+ Turnstile)
 *   POST <root>/login              -> challenge cookie -> <root>/login/code
 *   GET  <root>/login/code         code entry for the challenge's stage (email | ntfy)
 *   POST <root>/login/code         email ok -> ntfy stage; ntfy ok -> session -> <root>
 *   POST <root>/login/resend       a new phone code (ntfy stage only, NTFY_RESENDS max)
 *   POST <root>/logout
 *   GET  <root>                    signed in: the dashboard - plugin tiles + health
 *   *    <root><plugin.path>/...   signed in: plugin.fetch(request, env, ctx, admin)
 *
 * config.requireSecondFactor (default true) gates the ntfy stage - see the
 * SECOND FACTOR GATE in auth.js. Off: the emailed code alone signs you in, and
 * /login/resend does not exist.
 *
 * ── A PLUGIN ─────────────────────────────────────────────────────────────────────
 *   { id: "forms",                       [a-z0-9-], unique
 *     path: "/forms", label: "Forms",    mount point (one segment) and nav link
 *     fetch(request, env, ctx, admin),   -> Response, or null for "not found"
 *     dashboard(env, admin),             optional: html`` tile(s) for the dashboard
 *     health(env, admin),                optional: [{name, ok, detail}] for the dashboard
 *     flags(env),                        optional: {flag: boolean} for the public /health
 *     templates: { name: (ctx, data) => html`` } }   defaults; config.templates wins
 *
 * `admin` is {user, root, base (root + path), path (inside the mount, "/" at
 * least), url, c (the template ctx), t (templates), page(title, body, opts),
 * redirect(location), notFound()}. A plugin is only ever called for a signed-in
 * user: there is no public plugin route.
 *
 * ── WHAT THE CORE ENFORCES, PLUGINS INCLUDED ─────────────────────────────────────
 *   - Every POST carries an Origin equal to the request's own (CSRF), on top of
 *     SameSite=Strict cookies. Only GET, HEAD and POST reach anything.
 *   - Fetch Metadata: a browser request that is not a top-level navigation
 *     (Sec-Fetch-Mode other than navigate, or a frame) is refused. A script on
 *     the public site shares this origin; this stops it silently fetch()ing an
 *     admin page with the admin's cookie. Browsers without the headers pass.
 *   - A plugin never sees the admin cookies: they are removed from the request
 *     it is given, and any Set-Cookie for them in its response is dropped.
 *   - Every response is no-store, nosniff and unframeable; an HTML page gets a
 *     CSP that allows script only from Turnstile, unless the plugin set its own.
 *
 * Env:
 *   ADMIN_DB              D1: login state (and formsPlugin's workflow log): db/migrations
 *   ADMIN_USERS           secret JSON allowlist - see auth.js parseUsers
 *   ADMIN_SENDER          From: address of the login-code email
 *   MAILTRAP_API_TOKEN    secret
 *   TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY
 *   NTFY_SERVER           optional, default https://ntfy.sh
 *   NTFY_TOKEN            optional secret, for a server with access control
 *   DRY_RUN               "true" prints codes (localhost only) instead of sending
 *   ADMIN_ROOT            optional override of config.root
 *   ADMIN_SESSION_TTL_S   optional, seconds: a session's absolute limit (auth.js SESSION_TTL_S)
 *   ADMIN_SESSION_IDLE_S  optional, seconds: its idle limit (auth.js SESSION_IDLE_S)
 */

import {
  parseUsers, sessionLimits, startLogin, challengeStage, verifyCode, resendNtfyCode, getSession, endSession,
  CODE_TTL_S, NTFY_TTL_S,
} from "./auth.js";
import { sendEmailCode, sendNtfyCode } from "./deliver.js";
import { verifyTurnstile } from "./turnstile.js";
import { DEFAULT_TEMPLATES, DEFAULT_COPY, TOKENS } from "./templates.js";
import { coreChecks, coreFlags } from "./modules/health.js";
import { dateFormatters } from "./dates.js";
import { CSP } from "./csp.js";

const CHALLENGE_COOKIE = "__Host-admin-ch";
const SESSION_COOKIE = "__Host-admin-s";
const ADMIN_COOKIES = new Set([CHALLENGE_COOKIE, SESSION_COOKIE]);


// Always set, whatever a plugin says: admin data is never cached, sniffed or framed.
const FORCED_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};
const DEFAULT_HEADERS = {
  "content-security-policy": CSP,
  // NOT no-referrer: under it browsers send `Origin: null` on every form POST,
  // even same-origin, and the Origin check below refuses them all.
  // same-origin still sends nothing to any other site.
  "referrer-policy": "same-origin",
};

const ROOT = /^(\/[a-z0-9_-]+)+$/;
const PLUGIN_ID = /^[a-z0-9-]{1,40}$/;
const MOUNT = /^\/[a-z0-9-]{1,40}$/;
const RESERVED = new Set(["/login", "/logout", "/health"]);
const HOOKS = ["fetch", "dashboard", "health", "flags"];

export function normaliseRoot(r) {
  const root = String(r ?? "").replace(/\/+$/, "");
  if (!ROOT.test(root)) throw new Error(`admin root "${r}" must look like /admin or /staff/admin`);
  return root;
}

function checkConfig(config) {
  const { site } = config;
  if (!site?.name || !site?.url) throw new Error("createAdmin: config.site needs name and url");
  const theme = site.theme?.dark || site.theme?.light;
  const missing = TOKENS.filter((k) => !theme?.[k]);
  if (missing.length) throw new Error(`createAdmin: site.theme is missing ${missing.join(", ")}`);
  if (config.forms || config.workflows || config.views) {
    throw new Error("createAdmin: forms, workflows and views moved into a plugin - " +
      "plugins: [formsPlugin({ toRecord, list, workflows, views })]");
  }
}

export function normalisePlugins(list = []) {
  const ids = new Set();
  const paths = new Set();
  return list.map((p) => {
    const where = `createAdmin: plugin "${p?.id}"`;
    if (!PLUGIN_ID.test(p?.id ?? "")) throw new Error(`${where}: id must match ${PLUGIN_ID}`);
    if (ids.has(p.id)) throw new Error(`${where}: id is used twice`);
    ids.add(p.id);
    for (const k of HOOKS) {
      if (p[k] !== undefined && typeof p[k] !== "function") throw new Error(`${where}: ${k} must be a function`);
    }
    if ((p.path === undefined) !== (p.fetch === undefined)) throw new Error(`${where}: path and fetch go together`);
    if (p.path !== undefined) {
      if (!MOUNT.test(p.path) || RESERVED.has(p.path)) throw new Error(`${where}: path "${p.path}" must be one segment like /forms, not ${[...RESERVED].join(" ")}`);
      if (paths.has(p.path)) throw new Error(`${where}: path "${p.path}" is used twice`);
      paths.add(p.path);
    }
    return p;
  });
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function respond(body, { status = 200, cookies = [], type = "text/html; charset=utf-8", headers = {} } = {}) {
  const h = new Headers({ "content-type": type, ...DEFAULT_HEADERS, ...headers, ...FORCED_HEADERS });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(body, { status, headers: h });
}

const text = (body, status, headers = {}) => respond(body, { status, type: "text/plain; charset=utf-8", headers });

const redirect = (location, cookies = []) =>
  respond(null, { status: 303, cookies, headers: { location } });

/** The request a plugin sees: the same, minus the admin's own cookies. */
function withoutAdminCookies(request) {
  const kept = (request.headers.get("cookie") || "").split(";").map((s) => s.trim())
    .filter((s) => s && !ADMIN_COOKIES.has(s.split("=")[0].trim()));
  const headers = new Headers(request.headers);
  if (kept.length) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
  return new Request(request, { headers });
}

/** A plugin's response with the core's headers forced on and admin cookies kept out. */
function harden(res) {
  const h = new Headers();
  for (const [k, v] of res.headers) {
    if (k === "set-cookie") continue;
    h.append(k, v);
  }
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (!ADMIN_COOKIES.has(c.split("=")[0].trim())) h.append("set-cookie", c);
  }
  for (const [k, v] of Object.entries(DEFAULT_HEADERS)) if (!h.has(k)) h.set(k, v);
  for (const [k, v] of Object.entries(FORCED_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Fetch Metadata: true for a browser request that is not a top-level
 * navigation - a fetch()/XHR, a subresource, or a frame. Absent headers (an old
 * browser, curl) pass: the cookies and the Origin check still apply.
 */
function notANavigation(request) {
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  return (mode !== null && mode !== "navigate") || (dest !== null && dest !== "document");
}

const ntfyFailed = (sent) =>
  `Your phone code could not be sent (${sent.reason}). Wait a minute, then use "Send a new phone code".`;

function timeFormatter(lang, timeZone) {
  const f = new Intl.DateTimeFormat(lang || "en", { timeZone, dateStyle: "medium", timeStyle: "short" });
  return (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso ?? "") : f.format(d);
  };
}

/** A plugin hook's result, or `fallback` (logged) if it throws. */
async function guarded(p, hook, fallback, run) {
  try {
    return await run();
  } catch (err) {
    console.log(`[admin] plugin ${p.id} ${hook} failed: ${err.stack || err.message}`);
    return fallback;
  }
}

export function createAdmin(config) {
  checkConfig(config);
  const plugins = normalisePlugins(config.plugins);
  const templates = Object.assign({}, DEFAULT_TEMPLATES, ...plugins.map((p) => p.templates ?? {}), config.templates);
  const copy = { ...DEFAULT_COPY, ...config.copy };
  const fmtTime = timeFormatter(config.site.lang, config.timeZone || "UTC");
  const { fmtDate, fmtDateTime } = dateFormatters(config.timeZone || "UTC");
  const configRoot = normaliseRoot(config.root ?? "/admin");
  const secondFactor = config.requireSecondFactor !== false;
  const liveHost = new URL(config.site.url).host;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const root = env.ADMIN_ROOT ? normaliseRoot(env.ADMIN_ROOT) : configRoot;
      if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return text("Not found", 404);
      const path = url.pathname.slice(root.length).replace(/\/+$/, "") || "/";
      const method = request.method;
      const GET = method === "GET" || method === "HEAD";

      if (!GET && method !== "POST") return text("Method not allowed", 405, { allow: "GET, HEAD, POST" });
      if (method === "POST" && request.headers.get("origin") !== url.origin) return text("Forbidden", 403);

      if (path === "/health" && GET) {
        const flags = await coreFlags(env, { secondFactor });
        for (const p of plugins.filter((x) => x.flags)) {
          Object.assign(flags, await guarded(p, "flags", {}, () => p.flags(env)));
        }
        return respond(JSON.stringify({ ok: true, ...flags }), { type: "application/json; charset=utf-8" });
      }

      if (notANavigation(request)) return text("Forbidden", 403);

      const nav = plugins.filter((p) => p.path && p.label).map((p) => ({ href: `${root}${p.path}`, label: p.label }));
      const c = {
        site: config.site, copy, root, base: root, nav, user: null, t: templates, fmtTime, fmtDate, fmtDateTime, secondFactor,
        host: url.host, liveHost, isLive: url.host === liveHost,
      };
      const pageFor = (ctxt) => (title, body, opts = {}) =>
        respond(String(templates.layout(ctxt, { title, body, turnstile: opts.turnstile, wide: opts.wide })), opts);
      const page = pageFor(c);

      const db = env.ADMIN_DB;
      if (!db) {
        return page("Not configured", templates.message(c, { heading: "Not configured", text: "The admin database is not bound." }), { status: 503 });
      }
      const { users, error: usersError } = parseUsers(env.ADMIN_USERS);
      if (usersError) console.log(`[admin] ${usersError} - nobody can sign in`);
      const limits = sessionLimits(env);
      const jar = readCookies(request);
      const clearChallenge = cookie(CHALLENGE_COOKIE, "", 0);

      // ── sign in ────────────────────────────────────────────────────────────
      if (path === "/login") {
        const siteKey = env.TURNSTILE_SITE_KEY || "";
        if (GET) {
          if (await getSession({ db, users, limits, token: jar[SESSION_COOKIE] })) return redirect(root);
          const error = url.searchParams.has("restart")
            ? "That sign-in expired or had too many wrong codes. Please start again." : "";
          return page("Sign in", templates.loginEmail(c, { error, siteKey }), { turnstile: true });
        }
        const form = await request.formData();
        const email = String(form.get("email") ?? "").slice(0, 254);
        const ts = await verifyTurnstile(form.get("cf-turnstile-response"), env.TURNSTILE_SECRET_KEY, url.hostname);
        if (!ts.ok) {
          console.log(`[admin] login refused: turnstile ${ts.reason}`);
          return page("Sign in", templates.loginEmail(c, {
            error: "The anti-spam check did not pass. Please try again.", email, siteKey,
          }), { status: 400, turnstile: true });
        }
        const { challengeId, deliver } = await startLogin({ db, users, email });
        if (deliver) {
          ctx.waitUntil(sendEmailCode({
            env, site: config.site, request, to: deliver.email, code: deliver.code, minutes: CODE_TTL_S / 60, secondFactor,
          }).catch((err) => console.log(`[admin] email code failed: ${err.message}`)));
        }
        return redirect(`${root}/login/code`, [cookie(CHALLENGE_COOKIE, challengeId, CODE_TTL_S)]);
      }

      if (path === "/login/code") {
        const challengeId = jar[CHALLENGE_COOKIE];
        if (GET) {
          const stage = await challengeStage({ db, challengeId });
          if (!stage) return redirect(`${root}/login`, [clearChallenge]);
          return page("Sign in", templates.loginCode(c, { stage }));
        }
        const form = await request.formData();
        const r = await verifyCode({ db, users, challengeId, code: form.get("code"), secondFactor, limits });
        if (!r.ok) {
          if (r.reason !== "wrong-code") return redirect(`${root}/login?restart=1`, [clearChallenge]);
          const stage = await challengeStage({ db, challengeId });
          return page("Sign in", templates.loginCode(c, {
            stage,
            error: `That code is not right. ${r.attemptsLeft} attempt${r.attemptsLeft === 1 ? "" : "s"} left.`,
          }), { status: 400 });
        }
        if (secondFactor) {
          if (r.ntfy) {
            // Awaited, not waitUntil: see sendNtfyCode for why this one is shown.
            const sent = await sendNtfyCode({
              env, site: config.site, request, topic: r.ntfy.topic, code: r.ntfy.code, minutes: NTFY_TTL_S / 60,
            });
            if (!sent.ok) return page("Sign in", templates.loginCode(c, { stage: "ntfy", error: ntfyFailed(sent) }), { status: 502 });
            return redirect(`${root}/login/code`);
          }
        }
        console.log(`[admin] signed in: ${r.session.email}`);
        return redirect(root, [clearChallenge, cookie(SESSION_COOKIE, r.session.token, r.session.maxAge)]);
      }

      if (secondFactor) {
        if (path === "/login/resend" && method === "POST") {
          const r = await resendNtfyCode({ db, users, challengeId: jar[CHALLENGE_COOKIE] });
          if (!r.ok && r.reason === "no-challenge") return redirect(`${root}/login?restart=1`, [clearChallenge]);
          if (!r.ok) {
            return page("Sign in", templates.loginCode(c, {
              stage: "ntfy", error: "No more phone codes can be sent for this sign-in. Please start again later.",
            }), { status: 429 });
          }
          const sent = await sendNtfyCode({
            env, site: config.site, request, topic: r.ntfy.topic, code: r.ntfy.code, minutes: NTFY_TTL_S / 60,
          });
          if (!sent.ok) return page("Sign in", templates.loginCode(c, { stage: "ntfy", error: ntfyFailed(sent) }), { status: 502 });
          return page("Sign in", templates.loginCode(c, {
            stage: "ntfy", notice: "A new code has been sent to your phone. Earlier codes no longer work.",
          }));
        }
      }

      if (path === "/logout" && method === "POST") {
        await endSession({ db, token: jar[SESSION_COOKIE] });
        return redirect(`${root}/login`, [cookie(SESSION_COOKIE, "", 0)]);
      }

      // ── everything below needs a session ──────────────────────────────────
      const user = await getSession({ db, users, limits, token: jar[SESSION_COOKIE] });
      if (!user) {
        return GET ? redirect(`${root}/login`, [cookie(SESSION_COOKIE, "", 0)]) : text("Forbidden", 403);
      }
      c.user = user;
      const notFound = () => page("Not found", templates.message(c, { heading: "Not found", text: "There is nothing at this address." }), { status: 404 });

      const adminFor = (p, subPath = "/") => {
        const pc = { ...c, base: `${root}${p.path ?? ""}` };
        return {
          user, root, base: pc.base, path: subPath, url, c: pc, t: templates,
          page: pageFor(pc), redirect: (location) => redirect(location), notFound,
        };
      };
      const call = async (p, hook, subPath) => {
        try {
          const res = await p[hook](withoutAdminCookies(request), env, ctx, adminFor(p, subPath));
          return res == null ? null : harden(res);
        } catch (err) {
          console.log(`[admin] plugin ${p.id} ${hook} ${url.pathname} failed: ${err.stack || err.message}`);
          return page("Unavailable", templates.message(c, { heading: "Unavailable", text: "Something went wrong. The Worker log has the detail." }), { status: 503 });
        }
      };

      if (path === "/") {
        if (!GET) return text("Method not allowed", 405, { allow: "GET, HEAD" });
        const [core, extra, cards] = await Promise.all([
          coreChecks(env, { secondFactor }),
          Promise.all(plugins.filter((p) => p.health).map((p) => guarded(p, "health",
            [{ name: `Plugin: ${p.label || p.id}`, ok: false, detail: "its health check failed - see the Worker log" }],
            () => p.health(env, adminFor(p))))),
          Promise.all(plugins.filter((p) => p.dashboard).map((p) => guarded(p, "dashboard", "", () => p.dashboard(env, adminFor(p))))),
        ]);
        return page("Dashboard", templates.dashboard(c, { checks: [...core, ...extra.flat()], cards }));
      }

      const p = plugins.find((x) => x.path && (path === x.path || path.startsWith(`${x.path}/`)));
      if (!p) return notFound();
      return (await call(p, "fetch", path.slice(p.path.length) || "/")) ?? notFound();
    },
  };
}

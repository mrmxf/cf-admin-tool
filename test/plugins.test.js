import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS } from "./d1.js";
import { createAdmin, normalisePlugins, html } from "../index.js";
import { startLogin, verifyCode, parseUsers } from "../src/auth.js";
import { verifyTurnstile } from "../src/turnstile.js";

const ORIGIN = "http://localhost:8787";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const SITE = { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } };
const USERS = JSON.stringify([{ email: "staff@example.org" }]);

let seen;
const echo = {
  id: "echo", path: "/echo", label: "Echo",
  templates: { echoTile: (ctx) => html`<div class="tile" id="echo-tile">${ctx.base}</div>` },
  async fetch(request, env, ctx, admin) {
    seen = { cookie: request.headers.get("cookie"), path: admin.path, base: admin.base, user: admin.user.email };
    if (admin.path === "/page") return admin.page("Echo", html`<p id="echo-page">${admin.c.base}</p>`);
    if (admin.path === "/raw") {
      return new Response("raw", { headers: [["set-cookie", "__Host-admin-s=stolen; Path=/"], ["set-cookie", "mine=1; Path=/admin/echo"], ["cache-control", "max-age=3600"]] });
    }
    if (admin.path === "/boom") throw new Error("boom");
    if (request.method === "POST") return new Response(`posted ${(await request.formData()).get("x")}`);
    return null;
  },
  async dashboard(env, admin) { return admin.t.echoTile(admin.c); },
  async health() { return [{ name: "Echo", ok: true, detail: "fine" }]; },
  async flags() { return { echo: true }; },
};
const broken = {
  id: "broken",
  async health() { throw new Error("nope"); },
  async dashboard() { throw new Error("nope"); },
};

const admin = createAdmin({ site: SITE, requireSecondFactor: false, plugins: [echo, broken] });

let env, realLog, realFetch;
beforeEach(() => {
  env = { ADMIN_DB: fakeD1(AUTH_MIGRATIONS), ADMIN_USERS: USERS, DRY_RUN: "true", TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "s" };
  seen = null;
  realLog = console.log;
  console.log = () => {};
  realFetch = globalThis.fetch;
});
afterEach(() => { console.log = realLog; globalThis.fetch = realFetch; });

async function session() {
  const users = parseUsers(USERS).users;
  const s = await startLogin({ db: env.ADMIN_DB, users, email: "staff@example.org" });
  const r = await verifyCode({ db: env.ADMIN_DB, users, challengeId: s.challengeId, code: s.deliver.code, secondFactor: false });
  return `__Host-admin-s=${r.session.token}`;
}

function call(path, { method = "GET", cookie = "", headers = {}, form } = {}) {
  const h = { cookie, ...headers };
  if (method === "POST") h.origin ??= ORIGIN;
  return admin.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body: form ? new URLSearchParams(form) : undefined }), env, { waitUntil() {} });
}

test("plugin config is checked at construction", () => {
  const bad = (p, re) => assert.throws(() => normalisePlugins([p]), re);
  bad({ id: "Bad" }, /id must match/);
  bad({ id: "a", path: "/a" }, /path and fetch go together/);
  bad({ id: "a", fetch() {} }, /path and fetch go together/);
  bad({ id: "a", path: "/login", fetch() {} }, /must be one segment/);
  bad({ id: "a", path: "/a/b", fetch() {} }, /must be one segment/);
  bad({ id: "a", health: "yes" }, /health must be a function/);
  assert.throws(() => normalisePlugins([{ id: "a" }, { id: "a" }]), /used twice/);
  assert.throws(() => normalisePlugins([{ id: "a", path: "/x", fetch() {} }, { id: "b", path: "/x", fetch() {} }]), /used twice/);
  assert.throws(() => createAdmin({ site: SITE, forms: {} }), /moved into a plugin/);
});

test("a plugin is mounted at its path, signed in only, and never sees the admin cookies", async () => {
  assert.equal((await call("/admin/echo/page")).headers.get("location"), "/admin/login", "signed out: to login");
  const auth = await session();
  const res = await call("/admin/echo/page", { cookie: `${auth}; other=1; __Host-admin-ch=abc` });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<p id="echo-page">\/admin\/echo<\/p>/);
  assert.deepEqual(seen, { cookie: "other=1", path: "/page", base: "/admin/echo", user: "staff@example.org" });

  assert.equal((await call("/admin/echo/nothing", { cookie: auth })).status, 404, "null is not found");
  assert.equal((await call("/admin/echoes", { cookie: auth })).status, 404, "a mount matches whole segments only");
  assert.equal((await call("/admin/echo/boom", { cookie: auth })).status, 503, "a throw is a generic 503");
  const post = await call("/admin/echo/x", { method: "POST", cookie: auth, form: { x: "hi" } });
  assert.equal(await post.text(), "posted hi", "the body reaches the plugin");
  assert.equal((await call("/admin/echo/x", { method: "POST", cookie: auth, form: { x: "hi" }, headers: { origin: "https://evil.example" } })).status, 403);
});

test("a plugin's response gets the core's headers, and cannot set the admin cookies", async () => {
  const res = await call("/admin/echo/raw", { cookie: await session() });
  assert.equal(res.headers.get("cache-control"), "no-store", "forced over the plugin's own");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.deepEqual(res.headers.getSetCookie(), ["mine=1; Path=/admin/echo"]);
});

test("the dashboard has each plugin's tile, nav link and health; a failing plugin is shown, not fatal", async () => {
  const page = await (await call("/admin", { cookie: await session() })).text();
  assert.match(page, /<div class="tile" id="echo-tile">\/admin\/echo<\/div>/);
  assert.match(page, /<a href="\/admin\/echo">Echo<\/a>/);
  assert.match(page, /<td>Echo<\/td>/);
  assert.match(page, /<td>Plugin: broken<\/td><td><span class="status bad">/);
  const health = await (await call("/admin/health")).json();
  assert.equal(health.echo, true, "plugin flags are merged into the public health");
});

test("Fetch Metadata: only a top-level navigation reaches a page", async () => {
  const auth = await session();
  const as = (mode, dest) => call("/admin/echo/page", { cookie: auth, headers: { "sec-fetch-mode": mode, "sec-fetch-dest": dest, "sec-fetch-site": "same-origin" } });
  assert.equal((await as("navigate", "document")).status, 200);
  assert.equal((await as("cors", "empty")).status, 403, "a same-origin fetch() by a script on the public site");
  assert.equal((await as("no-cors", "image")).status, 403);
  assert.equal((await as("navigate", "iframe")).status, 403);
  assert.equal((await call("/admin/login", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403);
  assert.equal((await call("/admin/health", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 200,
    "the public health JSON is exempt");
});

test("Turnstile: a token solved on another host is refused; localhost is exempt", async () => {
  globalThis.fetch = async () => Response.json({ success: true, hostname: "elsewhere.example" });
  assert.deepEqual(await verifyTurnstile("t", "s", "site.example"), { ok: false, reason: "hostname-mismatch: elsewhere.example" });
  assert.deepEqual(await verifyTurnstile("t", "s", "localhost"), { ok: true });
  globalThis.fetch = async () => Response.json({ success: true, hostname: "site.example" });
  assert.deepEqual(await verifyTurnstile("t", "s", "site.example"), { ok: true });
});

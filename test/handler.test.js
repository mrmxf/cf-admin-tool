import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, EVENTS_MIGRATIONS } from "./d1.js";
import { createAdmin, formsPlugin } from "../index.js";

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;
const ORIGIN = "http://localhost:8787";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));

const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});

const admin = createAdmin({
  site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
  plugins: [formsPlugin({
    toRecord, list: [{ id: "parking", label: "Parking", path: "/forms/parking" }],
    workflows: [{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }],
  })],
});

let env, logs, realFetch, realLog, pending;
beforeEach(() => {
  env = {
    ADMIN_DB: fakeD1(AUTH_MIGRATIONS, ...EVENTS_MIGRATIONS),
    FORM_DB: fakeD1(SCHEMA),
    ADMIN_USERS: JSON.stringify([{ email: "staff@example.org", ntfyTopic: "topic-abc" }]),
    DRY_RUN: "true",
    TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
  };
  logs = [];
  pending = [];
  realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes("turnstile")) return Response.json({ success: true });
    throw new Error(`unexpected fetch ${u}`);
  };
});
afterEach(() => { console.log = realLog; globalThis.fetch = realFetch; });

const ctx = { waitUntil: (p) => pending.push(p) };

async function call(path, { method = "GET", form, cookie = "", origin = ORIGIN } = {}) {
  const headers = { cookie };
  if (origin) headers.origin = origin;
  const req = new Request(`${ORIGIN}${path}`, { method, headers, body: form ? new URLSearchParams(form) : undefined });
  const res = await admin.fetch(req, env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}

const cookiesOf = (res) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split("=")));
const lastCode = () => logs.map((l) => l.match(/code .*: (\d{6})$/)?.[1]).filter(Boolean).at(-1);

test("the whole login, then the forms pages", async () => {
  let res = await call("/admin/login", { method: "POST", form: { email: "Staff@Example.org", "cf-turnstile-response": "t" } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin/login/code");
  const ch = cookiesOf(res)["__Host-admin-ch"];
  assert.match(res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);

  res = await call("/admin/login/code", { cookie: `__Host-admin-ch=${ch}` });
  assert.match(await res.text(), /Check your email/);

  res = await call("/admin/login/code", { method: "POST", form: { code: lastCode() }, cookie: `__Host-admin-ch=${ch}` });
  assert.equal(res.headers.get("location"), "/admin/login/code");
  assert.ok(logs.some((l) => l.includes("ntfy code for topic topic-abc")));

  res = await call("/admin/login/code", { cookie: `__Host-admin-ch=${ch}` });
  assert.match(await res.text(), /Check your phone/);

  res = await call("/admin/login/code", { method: "POST", form: { code: lastCode() }, cookie: `__Host-admin-ch=${ch}` });
  assert.equal(res.headers.get("location"), "/admin");
  const s = cookiesOf(res)["__Host-admin-s"];
  assert.match(s, /^[0-9a-f]{64}$/);
  const auth = `__Host-admin-s=${s}`;

  env.FORM_DB.sqlite.prepare(`INSERT INTO submissions (uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES ('11111111-1111-4111-8111-111111111111', 'parking', '${ORIGIN}/forms/parking', '2026-10-01T10:00:00.000Z', 1, 'sent',
    '{"fields":[{"name":"name"}]}', '{"name":"<script>alert(1)</script>"}', '{}', '{"events":[]}')`).run();

  res = await call("/admin", { cookie: auth });
  assert.equal(res.status, 200);
  const dash = await res.text();
  assert.doesNotMatch(dash, /Workflows/, "no workflows card");
  assert.match(dash, /Health/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);

  res = await call("/admin/forms", { cookie: auth });
  const idx = await res.text();
  assert.match(idx, /<p class="count">1 sent of 1 submitted<\/p>/);
  assert.match(idx, /<em>newest<\/em>: 2026-10-01 @ 10:00/, "no timeZone: UTC");

  res = await call("/admin/forms/parking", { cookie: auth });
  const list = await res.text();
  assert.doesNotMatch(list, /<script>alert/);
  assert.match(list, /&lt;script&gt;alert/);

  res = await call("/admin/forms/parking/11111111-1111-4111-8111-111111111111", { cookie: auth });
  const rec = await res.text();
  assert.match(rec, /not implemented yet/);
  assert.doesNotMatch(rec, /<script>alert/);

  res = await call("/admin/forms/nope", { cookie: auth });
  assert.equal(res.status, 404);

  res = await call("/admin/logout", { method: "POST", cookie: auth });
  assert.equal(res.headers.get("location"), "/admin/login");
  res = await call("/admin", { cookie: auth });
  assert.equal(res.headers.get("location"), "/admin/login");
});

test("an address not on the list gets the same response, and nothing is sent", async () => {
  const a = await call("/admin/login", { method: "POST", form: { email: "staff@example.org", "cf-turnstile-response": "t" } });
  const sentForListed = logs.length;
  const b = await call("/admin/login", { method: "POST", form: { email: "stranger@example.org", "cf-turnstile-response": "t" } });
  assert.equal(a.status, b.status);
  assert.equal(a.headers.get("location"), b.headers.get("location"));
  assert.equal(a.headers.get("set-cookie").replace(/=[0-9a-f]{32};/, "=X;"), b.headers.get("set-cookie").replace(/=[0-9a-f]{32};/, "=X;"));
  assert.equal(logs.length, sentForListed, "nothing printed for the stranger");

  const ch = cookiesOf(b)["__Host-admin-ch"];
  const page = await (await call("/admin/login/code", { cookie: `__Host-admin-ch=${ch}` })).text();
  assert.match(page, /Check your email/);
});

test("pages use a referrer policy under which browsers send a real Origin on POST", async () => {
  // Under no-referrer a browser sends `Origin: null` on same-origin form POSTs,
  // so every sign-in would hit the 403 below. These tests set Origin by hand and
  // cannot see that, so pin the policy instead.
  const res = await call("/admin/login");
  assert.ok(["same-origin", "strict-origin", "strict-origin-when-cross-origin"]
    .includes(res.headers.get("referrer-policy")), res.headers.get("referrer-policy"));
});

test("cross-origin or origin-less POSTs are refused", async () => {
  assert.equal((await call("/admin/login", { method: "POST", form: { email: "x" }, origin: "https://evil.test" })).status, 403);
  assert.equal((await call("/admin/login", { method: "POST", form: { email: "x" }, origin: null })).status, 403);
});

test("signed-out pages redirect to login; outside the root is 404; health is public flags", async () => {
  assert.equal((await call("/admin/forms")).headers.get("location"), "/admin/login");
  assert.equal((await call("/elsewhere")).status, 404);
  assert.equal((await call("/administrator")).status, 404);
  const h = await (await call("/admin/health")).json();
  assert.equal(h.ok, true);
  assert.equal(h.usersConfigured, true);
  assert.equal(JSON.stringify(h).includes("staff@example.org"), false);
});

test("a failed Turnstile check never starts a challenge", async () => {
  globalThis.fetch = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  const res = await call("/admin/login", { method: "POST", form: { email: "staff@example.org", "cf-turnstile-response": "t" } });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(env.ADMIN_DB.sqlite.prepare("SELECT COUNT(*) AS n FROM challenges").get().n, 0);
});

test("DRY_RUN on a non-local host prints no code", async () => {
  const req = new Request("https://site.example/admin/login", {
    method: "POST", headers: { origin: "https://site.example" },
    body: new URLSearchParams({ email: "staff@example.org", "cf-turnstile-response": "t" }),
  });
  await admin.fetch(req, env, ctx);
  await Promise.all(pending.splice(0));
  assert.equal(lastCode(), undefined);
});

test("a failed phone push is shown, not silent; a resend that works says so", async () => {
  env.DRY_RUN = "false";
  env.MAILTRAP_API_TOKEN = "mt";
  env.ADMIN_SENDER = "admin@site.example";
  let emailCode, ntfyCode, ntfyStatus = 429, ntfyAuth;
  globalThis.fetch = async (u, init = {}) => {
    u = String(u);
    if (u.includes("turnstile")) return Response.json({ success: true });
    if (u.includes("mailtrap")) { emailCode = JSON.parse(init.body).text.match(/\d{6}/)[0]; return Response.json({ success: true }); }
    if (u.startsWith("https://ntfy.sh/topic-abc")) {
      ntfyAuth = init.headers.Authorization;
      if (ntfyStatus !== 200) return Response.json({ code: 42901, http: 429, error: "limit reached: too many requests" }, { status: 429 });
      ntfyCode = String(init.body).match(/\d{6}/)[0];
      return Response.json({ id: "x" });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  env.NTFY_TOKEN = "tk_test";

  let res = await call("/admin/login", { method: "POST", form: { email: "staff@example.org", "cf-turnstile-response": "t" } });
  const jar = `__Host-admin-ch=${cookiesOf(res)["__Host-admin-ch"]}`;
  res = await call("/admin/login/code", { method: "POST", form: { code: emailCode }, cookie: jar });
  assert.equal(res.status, 502);
  const failed = await res.text();
  assert.match(failed, /could not be sent/);
  assert.match(failed, /too many requests/);
  assert.match(failed, /Send a new phone code/);
  assert.equal(ntfyAuth, "Bearer tk_test");
  assert.ok(logs.some((l) => l.includes("token=yes") && l.includes("42901")));

  ntfyStatus = 200;
  res = await call("/admin/login/resend", { method: "POST", cookie: jar });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /A new code has been sent/);
  res = await call("/admin/login/code", { method: "POST", form: { code: ntfyCode }, cookie: jar });
  assert.equal(res.headers.get("location"), "/admin");
});

test("requireSecondFactor: false - the emailed code signs you in; no push, no resend route", async () => {
  const noSecond = createAdmin({
    site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
    requireSecondFactor: false,
  });
  env.ADMIN_USERS = JSON.stringify([{ email: "staff@example.org" }]);
  const go = async (path, opts = {}) => {
    const headers = { cookie: opts.cookie ?? "", origin: ORIGIN };
    const res = await noSecond.fetch(new Request(`${ORIGIN}${path}`, {
      method: opts.method ?? "GET", headers, body: opts.form ? new URLSearchParams(opts.form) : undefined,
    }), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  let res = await go("/admin/login", { method: "POST", form: { email: "staff@example.org", "cf-turnstile-response": "t" } });
  const jar = `__Host-admin-ch=${cookiesOf(res)["__Host-admin-ch"]}`;
  const page = await (await go("/admin/login/code", { cookie: jar })).text();
  assert.doesNotMatch(page, /Step 1 of 2/);
  res = await go("/admin/login/code", { method: "POST", form: { code: lastCode() }, cookie: jar });
  assert.equal(res.headers.get("location"), "/admin");
  assert.match(cookiesOf(res)["__Host-admin-s"], /^[0-9a-f]{64}$/);
  assert.equal(logs.some((l) => l.includes("ntfy")), false, "no push attempted");
  assert.equal((await go("/admin/login/resend", { method: "POST", cookie: jar })).status, 403, "resend route gone");
  assert.equal((await (await go("/admin/health")).json()).secondFactor, false);
});

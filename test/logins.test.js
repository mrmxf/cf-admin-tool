// The sign-in log: every step through the real routes, masking, grouping by
// attempt, paging, the tile, and that a broken log never breaks sign-in.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, LOGINS_MIGRATION } from "./d1.js";
import { createAdmin } from "../index.js";
import { maskEmail, RETAIN_S } from "../src/modules/logins.js";

const ORIGIN = "http://localhost:8787";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const SITE = { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } };
const STAFF = "staff@example.org";
const admin = createAdmin({ site: SITE, requireSecondFactor: false, plugins: [] });

let env, logs, pending, realLog, realFetch, turnstileOk;
beforeEach(() => {
  env = { ADMIN_DB: fakeD1(AUTH_MIGRATIONS, LOGINS_MIGRATION), ADMIN_USERS: JSON.stringify([{ email: STAFF }]),
    DRY_RUN: "true", TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "s" };
  logs = [];
  pending = [];
  turnstileOk = true;
  realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(turnstileOk ? { success: true, hostname: "localhost" } : { success: false, "error-codes": ["invalid-input-response"] });
});
afterEach(() => { console.log = realLog; globalThis.fetch = realFetch; });

function call(path, { method = "GET", cookie = "", form, db } = {}) {
  const headers = { cookie };
  if (method === "POST") headers.origin = ORIGIN;
  return admin.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: form ? new URLSearchParams(form) : undefined }),
    db ? { ...env, ADMIN_DB: db } : env, { waitUntil: (p) => pending.push(p) });
}
const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";
const rows = () => env.ADMIN_DB.sqlite.prepare("SELECT * FROM auth_events ORDER BY id").all().map((r) => ({ ...r }));

/** One whole attempt through the routes; returns the session cookie, if any. */
async function attempt(email, { code = null, wrong = 0 } = {}) {
  const seen = logs.length;
  const res = await call("/admin/login", { method: "POST", form: { email, "cf-turnstile-response": "t" } });
  const ch = cookieOf(res, "__Host-admin-ch");
  await Promise.all(pending.splice(0));
  const sent = logs.slice(seen).findLast((l) => l.includes(`DRY RUN email code for ${email}`))?.match(/(\d{6})$/)?.[1];
  for (let i = 0; i < wrong; i++) await call("/admin/login/code", { method: "POST", cookie: ch, form: { code: "000000" } });
  if (!code && !sent) return { ch };
  const done = await call("/admin/login/code", { method: "POST", cookie: ch, form: { code: code ?? sent } });
  return { ch, session: cookieOf(done, "__Host-admin-s") };
}

test("maskEmail keeps a first letter and the TLD, nothing more", () => {
  assert.equal(maskEmail("Jo.Bloggs@Gmail.com"), "j***@g***.com");
  assert.equal(maskEmail("a@b"), "a***@b***");
  assert.equal(maskEmail("nonsense"), "n***");
  assert.equal(maskEmail(""), "(none)");
});

test("one attempt is one group: requested, emailed, a wrong code, signed in, signed out", async () => {
  const { ch, session } = await attempt(STAFF, { wrong: 1 });
  assert.ok(session, "signed in");
  await call("/admin/logout", { method: "POST", cookie: session });
  const r = rows();
  assert.deepEqual(r.map((x) => x.step), ["code-requested", "code-emailed", "wrong-code", "signed-in", "signed-out"]);
  assert.equal(new Set(r.map((x) => x.attempt)).size, 1, "all one attempt, signing out included");
  assert.ok(r.every((x) => x.who === STAFF && x.origin === ORIGIN));
  assert.equal(r[2].detail, "email stage, 4 left");
  const challengeId = ch.split("=")[1];
  assert.ok(!JSON.stringify(r).includes(challengeId), "the challenge id (a live cookie) is never stored");
});

test("a stranger is masked, gets no code, and every guess is logged", async () => {
  await attempt("Someone@Elsewhere.net", { code: "123456" });
  const r = rows();
  assert.deepEqual(r.map((x) => [x.step, x.who, x.detail]), [
    ["code-requested", "s***@e***.net (not on the list)", "no code sent"],
    ["wrong-code", "s***@e***.net (not on the list)", "email stage, 4 left"],
  ]);
  assert.ok(!JSON.stringify(r).includes("someone"), "the full address is nowhere");
});

test("Turnstile refusals, expired sign-ins and limits are logged; the visitor's responses are unchanged", async () => {
  turnstileOk = false;
  const res = await call("/admin/login", { method: "POST", form: { email: STAFF, "cf-turnstile-response": "t" } });
  assert.equal(res.status, 400);
  turnstileOk = true;
  const late = await call("/admin/login/code", { method: "POST", cookie: "__Host-admin-ch=" + "a".repeat(32), form: { code: "111111" } });
  assert.match(late.headers.get("location"), /restart=1/);
  for (let i = 0; i < 4; i++) await attempt(STAFF);   // the 4th is over SEND_LIMIT
  const r = rows();
  assert.deepEqual(r[0].step, "turnstile-refused");
  assert.equal(r[0].detail.length > 0, true);
  assert.deepEqual([r[1].step, r[1].who], ["expired", ""]);
  assert.equal(r.at(-1).step, "code-requested");
  assert.equal(r.at(-1).detail, "a send limit was hit: no code sent");
});

test("the page: 10 attempts with all their steps, newest first; More gives the next 10; escaped", async () => {
  for (let i = 0; i < 12; i++) await attempt(`<b>x${i}@evil.example`);
  const auth = (await attempt(STAFF)).session;
  let page = await (await call("/admin/logins", { cookie: auth })).text();
  assert.match(page, /<h1>Sign-ins<\/h1>/);
  assert.equal([...page.matchAll(/<section class="attempt">/g)].length, 10);
  assert.ok(page.indexOf(STAFF) < page.indexOf("&lt;***@e***.example"), "newest first");
  assert.doesNotMatch(page, /<b>/, "what was typed is escaped");
  assert.match(page, /✅ signed in/);
  const before = page.match(/name="before" value="(\d+)"/)[1];
  assert.match(page, /<button type="submit" class="secondary">More<\/button>/);
  page = await (await call(`/admin/logins?before=${before}`, { cookie: auth })).text();
  assert.equal([...page.matchAll(/<section class="attempt">/g)].length, 3, "13 attempts: 10, then 3");
  assert.doesNotMatch(page, /name="before"/, "no More on the last page");
  assert.match(page, /href="\/admin\/logins">Newest<\/a>/);
  assert.equal((await call("/admin/logins")).headers.get("location"), "/admin/login", "signed in only");
});

test("the dashboard tile: the latest attempt and the day's counts", async () => {
  await attempt("nobody@x.example", { code: "123456" });
  const auth = (await attempt(STAFF)).session;
  const page = await (await call("/admin", { cookie: auth })).text();
  const tile = page.match(/<div class="tile (\w+)" id="tile-admin-logins">([\s\S]*?)<\/div>/);
  assert.equal(tile[1], "warn", "a refusal today");
  assert.match(tile[2], /href="\/admin\/logins">Sign-ins</);
  assert.match(tile[2], /latest: staff@example\.org, ✅ signed in/);
  assert.match(tile[2], /24 h: 1 signed in, 1 refused/);
});

test("old rows are pruned at the next attempt", async () => {
  env.ADMIN_DB.sqlite.prepare("INSERT INTO auth_events (origin, attempt, who, step, detail, created_at) VALUES (?, 'old', 'w', 'signed-in', '', ?)")
    .run(ORIGIN, Math.floor(Date.now() / 1000) - RETAIN_S - 10);
  await attempt(STAFF);
  assert.ok(!rows().some((r) => r.attempt === "old"));
});

test("a log that cannot be written never stops a sign-in; the page says it cannot be read", async () => {
  const db = fakeD1(AUTH_MIGRATIONS, LOGINS_MIGRATION);
  db.sqlite.exec("DROP TABLE auth_events");
  const res = await call("/admin/login", { method: "POST", form: { email: STAFF, "cf-turnstile-response": "t" }, db });
  await Promise.all(pending.splice(0));
  const code = logs.findLast((l) => l.includes("DRY RUN email code"))?.match(/(\d{6})$/)[1];
  const done = await call("/admin/login/code", { method: "POST", cookie: cookieOf(res, "__Host-admin-ch"), form: { code }, db });
  const session = cookieOf(done, "__Host-admin-s");
  assert.ok(session, "signed in anyway");
  assert.ok(logs.some((l) => l.includes("sign-in log not written")));
  assert.match(await (await call("/admin/logins", { cookie: session, db })).text(), /could not be read/);
  assert.match(await (await call("/admin", { cookie: session, db })).text(), /the sign-in log could not be read/);
});

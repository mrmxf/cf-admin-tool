// 0.4.0: what a consumer's own plugins build on - a workflow's `next`, a view's
// notice and statusText, the forms tiles, settings, latestEvents, allSubmissions.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, EVENTS_MIGRATIONS } from "./d1.js";
import {
  createAdmin, formsPlugin, html, readSetting, settingHistory, appendSetting, latestEvents, allSubmissions, sortKey,
} from "../index.js";
import { safeNext } from "../src/plugins/forms.js";
import { normaliseViews } from "../src/views.js";

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;
const ORIGIN = "http://localhost:8787";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});
const UID = "44444444-4444-4444-8444-444444444444";

const WORKFLOWS = [
  { id: "wf06", label: "Night", forms: ["parking"],
    run: async ({ method, fields, now }) => {
      if (method === "GET") return { body: html`<p>night</p>` };
      if (fields.get("same")) return { back: true, next: fields.get("next") };
      return { next: fields.get("next"),
        event: { event: "wf06-parked", timestamp: now.toISOString(), duration: 1, status: 200, statusMessage: "parked" } };
    } },
];
const admin = createAdmin({
  site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
  requireSecondFactor: false,
  plugins: [formsPlugin({
    toRecord, workflows: WORKFLOWS, tile: "Forms(all)",
    list: [{ id: "parking", label: "Parking requests", tile: "🅿️requests", path: "/forms/parking" }],
    views: [{
      id: "parking", label: "Parking", form: "parking",
      notice: async ({ origin }) => html`<p class="error" id="over">over the limit on <b>${origin}</b></p>`,
      columns: [{ label: "Reg", answer: "reg" }, { label: "Night", workflow: "wf06", statusText: { 200: "🚗 <in>" } }],
    }],
  })],
});

let env, logs, realFetch, realLog, pending;
beforeEach(() => {
  env = {
    ADMIN_DB: fakeD1(AUTH_MIGRATIONS, ...EVENTS_MIGRATIONS), FORM_DB: fakeD1(SCHEMA),
    ADMIN_USERS: JSON.stringify([{ email: "staff@example.org" }]),
    DRY_RUN: "true", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
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
async function call(path, { method = "GET", form, cookie = "" } = {}) {
  const res = await admin.fetch(new Request(`${ORIGIN}${path}`, {
    method, headers: { cookie, origin: ORIGIN }, body: form ? new URLSearchParams(form) : undefined,
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}
const cookiesOf = (res) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split("=")));
async function signIn() {
  let res = await call("/admin/login", { method: "POST", form: { email: "staff@example.org", "cf-turnstile-response": "t" } });
  const ch = `__Host-admin-ch=${cookiesOf(res)["__Host-admin-ch"]}`;
  const code = logs.map((l) => l.match(/code .*: (\d{6})$/)?.[1]).filter(Boolean).at(-1);
  res = await call("/admin/login/code", { method: "POST", form: { code }, cookie: ch });
  return `__Host-admin-s=${cookiesOf(res)["__Host-admin-s"]}`;
}
function insert(uid, outcome, answers, id) {
  env.FORM_DB.sqlite.prepare(`INSERT INTO submissions (${id ? "id, " : ""}uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES (${id ? "?, " : ""}?, 'parking', ?, '2026-10-01T10:00:00.000Z', 1, ?, '{"fields":[]}', ?, '{}', '{"events":[]}')`)
    .run(...(id ? [id] : []), uid, `${ORIGIN}/forms/parking`, outcome, JSON.stringify(answers));
}
function logEvent(uid, event, status, origin = ORIGIN, form = "parking") {
  env.ADMIN_DB.sqlite.prepare(`INSERT INTO workflow_events (origin, form, uid, event, timestamp, duration, status, status_message, actor, created_at)
    VALUES (?, ?, ?, ?, '2026-10-02T10:00:00.000Z', 1, ?, 'm', 'a@example.org', 0)`).run(origin, form, uid, event, status);
}

test("safeNext: a path under the admin root, or null", () => {
  assert.equal(safeNext("/admin/parking/manager?sort=reg#r-1", "/admin"), "/admin/parking/manager?sort=reg#r-1");
  assert.equal(safeNext("/admin", "/admin"), "/admin");
  for (const bad of ["//evil.example/admin", "https://evil.example/admin/x", "/administrator", "/admin/../x",
    "/admin/%2e%2e/x", "/admin/%2E%2E/%2e%2e/x", "/admin\\..\\x", "/admin/\nx", "admin/x", "", null, 7, "/x/admin/"]) {
    assert.equal(safeNext(bad, "/admin"), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("a workflow's next: the browser goes there after the event, or after back; never off the admin", async () => {
  const auth = await signIn();
  insert(UID, "sent", { reg: "R1" });
  const run = `/admin/forms/parking/${UID}/run/wf06`;
  let res = await call(run, { method: "POST", form: { next: "/admin/parking/manager?sort=make#r-1" }, cookie: auth });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin/parking/manager?sort=make#r-1");
  assert.equal(env.ADMIN_DB.sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_events").get().n, 1);

  res = await call(run, { method: "POST", form: { same: "1", next: "/admin/parking/manager" }, cookie: auth });
  assert.equal(res.headers.get("location"), "/admin/parking/manager", "back with next");
  assert.equal(env.ADMIN_DB.sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_events").get().n, 1, "back logs nothing");

  res = await call(run, { method: "POST", form: { next: "//evil.example/" }, cookie: auth });
  assert.equal(res.headers.get("location"), "/admin/forms/views/parking", "a bad next falls back to the view");
});

test("a view's notice is shown above the table, and statusText replaces a status in the cell only", async () => {
  const auth = await signIn();
  insert(UID, "sent", { reg: "R1" });
  logEvent(UID, "wf06-parked", 200);
  const view = await (await call("/admin/forms/views/parking", { cookie: auth })).text();
  assert.match(view, /<p class="error" id="over">over the limit on <b>http:\/\/localhost:8787<\/b><\/p>/, "the notice, its values escaped");
  assert.ok(view.indexOf('id="over"') < view.indexOf("<table"), "above the table");
  assert.match(view, />🚗 &lt;in&gt;<\/a>/, "statusText, escaped");
  const rec = await (await call(`/admin/forms/parking/${UID}`, { cookie: auth })).text();
  assert.match(rec, /<td>wf06-parked<\/td><td>200<\/td><td>m<\/td>/, "the history keeps the logged message");

  const bad = (col, re) => assert.throws(() => normaliseViews([{ id: "v", form: "parking", columns: [col] }],
    { forms: [{ id: "parking" }], workflows: [{ id: "wf06", forms: null }] }), re);
  bad({ label: "N", answer: "reg", statusText: { 200: "x" } }, /statusText/);
  bad({ label: "N", workflow: "wf06", statusText: { 99: "x" } }, /statusText/);
  bad({ label: "N", workflow: "wf06", statusText: {} }, /statusText/);
  assert.throws(() => normaliseViews([{ id: "v", form: "parking", notice: "x", columns: [{ label: "R", answer: "r" }] }],
    { forms: [{ id: "parking" }], workflows: [] }), /notice must be a function/);
});

test("a notice that throws shows nothing and is logged", async () => {
  const failing = createAdmin({
    site: { name: "T", url: "https://site.example", fonts: {}, theme: { dark: THEME } }, requireSecondFactor: false,
    plugins: [formsPlugin({ toRecord, list: [{ id: "parking", label: "P", path: "/p" }],
      views: [{ id: "parking", form: "parking", notice: async () => { throw new Error("db down"); }, columns: [{ label: "R", answer: "reg" }] }] })],
  });
  const auth = await signIn();
  const res = await failing.fetch(new Request(`${ORIGIN}/admin/forms/views/parking`, { headers: { cookie: auth } }), env, ctx);
  assert.equal(res.status, 200);
  assert.ok(logs.some((l) => /view parking notice failed: .*db down/.test(l)));
});

test("formsPlugin tiles: all forms, then one per form by its tile title - the same on /forms", async () => {
  const auth = await signIn();
  insert(UID, "sent", { reg: "R1" });
  const dash = await (await call("/admin", { cookie: auth })).text();
  assert.match(dash, /id="tile-forms">\s*<h3><a href="\/admin\/forms">Forms\(all\)<\/a><\/h3>\s*<p>1 submission across 1 form<\/p>/);
  assert.match(dash, /id="tile-form-parking">\s*<h3><a href="\/admin\/forms\/views\/parking">🅿️requests<\/a><\/h3>/);
  const idx = await (await call("/admin/forms", { cookie: auth })).text();
  assert.match(idx, /id="tile-form-parking">\s*<h3><a href="\/admin\/forms\/views\/parking">🅿️requests<\/a><\/h3>/);
  assert.throws(() => formsPlugin({ toRecord, list: [{ id: "a", label: "A", path: "/a", tile: " " }] }), /tile must be a title/);
});

test("sortKey ignores leading emoji and symbols", () => {
  assert.equal(sortKey("🅿️status"), "status");
  assert.equal(sortKey("🗓️⌚ countdown"), "countdown");
  assert.equal(sortKey("Forms(all)"), "Forms(all)");
});

test("settings: append-only per origin and key; the latest wins; history newest first", async () => {
  const db = env.ADMIN_DB;
  assert.equal(await readSetting(db, { origin: ORIGIN, key: "parking.max" }), null, "never set");
  await appendSetting(db, { origin: ORIGIN, key: "parking.max", value: "50", details: "start", actor: "a@example.org" });
  await appendSetting(db, { origin: ORIGIN, key: "parking.max", value: "55", details: "more room", actor: "b@example.org" });
  await appendSetting(db, { origin: "https://other.example", key: "parking.max", value: "9", actor: "c@example.org" });
  const now = await readSetting(db, { origin: ORIGIN, key: "parking.max" });
  assert.deepEqual([now.value, now.details, now.actor], ["55", "more room", "b@example.org"]);
  assert.deepEqual((await settingHistory(db, { origin: ORIGIN, key: "parking.max" })).map((h) => h.value), ["55", "50"]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM settings_events").get().n, 3, "nothing overwritten");
  await assert.rejects(appendSetting(db, { origin: ORIGIN, key: "Bad Key", value: "1", actor: "a" }), /must match/);
  await assert.rejects(appendSetting(db, { origin: ORIGIN, key: "k", value: 1, actor: "a" }), /value must be a string/);
  await assert.rejects(appendSetting(db, { origin: ORIGIN, key: "k", value: "1" }), /actor is required/);
  assert.equal(await readSetting(undefined, { origin: ORIGIN, key: "k" }), null, "no database: never set");
});

test("latestEvents: the latest event of one workflow per submission, on one origin and form", async () => {
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  logEvent(A, "wf02-approve", 201);
  logEvent(A, "wf020", 200);            // another workflow whose id starts the same: not wf02's
  logEvent(A, "wf02-approve", 500);      // a failed send: still the latest
  logEvent(B, "wf02-deny", 422);
  logEvent(B, "wf02-approve", 202);
  logEvent(B, "wf03-issued", 201);       // not wf02
  logEvent(B, "wf02-deny", 400, "https://other.example");
  logEvent(B, "wf02-deny", 400, ORIGIN, "contact");
  const m = await latestEvents(env.ADMIN_DB, { origin: ORIGIN, form: "parking", workflow: "wf02" });
  assert.deepEqual(Object.fromEntries([...m].map(([u, e]) => [u, `${e.event} ${e.status}`])),
    { [A]: "wf02-approve 500", [B]: "wf02-approve 202" });
  await assert.rejects(latestEvents(env.ADMIN_DB, { origin: ORIGIN, form: "parking", workflow: "x%" }), /not valid/);
});

test("allSubmissions: every page joined, newest first, up to max", async () => {
  for (let i = 1; i <= 120; i++) insert(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, i % 2 ? "sent" : "invalid", {}, i);
  const all = await allSubmissions(env.FORM_DB, { formId: "parking", origin: ORIGIN, outcome: "sent", toRecord });
  assert.equal(all.records.length, 60);
  assert.equal(all.truncated, false);
  assert.equal(all.records[0].id.endsWith("119"), true, "newest first");
  const capped = await allSubmissions(env.FORM_DB, { formId: "parking", origin: ORIGIN, toRecord, max: 70 });
  assert.equal(capped.records.length, 70);
  assert.equal(capped.truncated, true);
});

test("a view's counter: a first column numbering the counted rows oldest first, across pages", async () => {
  const counted = createAdmin({
    site: { name: "T", url: "https://site.example", fonts: {}, theme: { dark: THEME } }, requireSecondFactor: false,
    plugins: [formsPlugin({ toRecord, list: [{ id: "parking", label: "P", path: "/p" }],
      views: [{ id: "parking", form: "parking", columns: [{ label: "Reg", answer: "reg" }],
        counter: { label: "#", count: (r) => r.workflow.events.some((e) => e.event === "wf02-approve") } }] })],
  });
  const auth = await signIn();
  // 60 sent rows, oldest first; every third approved: 20 counted, 1..20, the newest #20.
  for (let i = 1; i <= 60; i++) {
    const uid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    insert(uid, "sent", { reg: `R${i}` }, i);
    if (i % 3 === 0) logEvent(uid, "wf02-approve", 201);
  }
  const get = async (q = "") => (await counted.fetch(new Request(`${ORIGIN}/admin/forms/views/parking${q}`, { headers: { cookie: auth } }), env, ctx)).text();
  const page1 = await get();
  assert.match(page1, /<thead><tr><th scope="col" class="ctr">#<\/th><th scope="col"><span class="d-full">Submitted/);
  const cells = (p) => [...p.matchAll(/<td class="ctr">(\d*)<\/td>[\s\S]*?>(R\d+)</g)].map((m) => `${m[2]}:${m[1]}`);
  assert.deepEqual(cells(page1).slice(0, 4), ["R60:20", "R59:", "R58:", "R57:19"], "newest first; the newest counted row has the total");
  const next = page1.match(/\?cursor=([^"]+)">Older/)[1];
  const page2 = cells(await get(`?cursor=${next}`));
  assert.deepEqual(page2.slice(-3), ["R3:1", "R2:", "R1:"], "page 2 continues: the oldest counted row is 1");
  assert.throws(() => normaliseViews([{ id: "v", form: "parking", counter: { label: "#" }, columns: [{ label: "R", answer: "r" }] }],
    { forms: [{ id: "parking" }], workflows: [] }), /counter needs a label and a count/);
});

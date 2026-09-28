import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, EVENTS_MIGRATIONS } from "./d1.js";
import { createAdmin, formsPlugin, html } from "../index.js";
import { normaliseViews, workflowEvent, eventText, cell } from "../src/views.js";
import { dateFormatters } from "../src/dates.js";

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;
const ORIGIN = "http://localhost:8787";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});

const FORMS = [{ id: "parking", label: "Parking", path: "/forms/parking" }];
const ran = [];
const WORKFLOWS = [
  { id: "wf02", label: "Approval" },   // no run(): a placeholder
  { id: "wf03", label: "Permit", forms: ["parking"],
    run: async ({ method, fields, record, user, now }) => {
      ran.push([method, record.id, user.email]);
      if (method === "GET") return { body: html`<p>Issue a permit?</p>` };
      if (fields.get("bad")) return { event: { event: "wf02", timestamp: "x", duration: 1, status: 200, statusMessage: "no" } };
      return { event: { event: "wf03-issued", timestamp: now.toISOString(), duration: 5, status: 201, statusMessage: "permit sent" } };
    } },
  { id: "wf09", label: "Elsewhere", forms: ["contact"] },
];
const VIEW = {
  id: "parking", label: "Parking view", form: "parking",
  columns: [
    { label: "Reg", answer: "reg", narrow: "fill" },
    { label: "Car", value: ({ answers: a }) => `${a.make} (${a.model})`, narrow: 6 },
    { label: "Approval", workflow: "wf02" },
    { label: "Permit", workflow: "wf03" },
  ],
};

test("normaliseViews: defaults, and a bad view fails at construction", () => {
  const [v] = normaliseViews([VIEW], { forms: FORMS, workflows: WORKFLOWS });
  assert.equal(v.outcome, "sent");
  const bad = (over, re) => assert.throws(() => normaliseViews([{ ...VIEW, ...over }], { forms: FORMS, workflows: WORKFLOWS }), re);
  bad({ id: "Bad Id" }, /must match/);
  bad({ form: "nope" }, /not in formsPlugin's list/);
  bad({ columns: [] }, /needs columns/);
  bad({ columns: [{ label: "x", answer: "a", workflow: "wf02" }] }, /one of answer, value, workflow/);
  bad({ columns: [{ label: "x", workflow: "wf99" }] }, /not in formsPlugin's workflows/);
  bad({ columns: [{ label: "x", workflow: "wf09" }] }, /not offered on form "parking"/);
  bad({ columns: [{ label: "x", answer: "a", narrow: "wide" }] }, /narrow must be/);
  bad({ columns: [{ label: "x", workflow: "wf02", narrow: 3 }] }, /cannot be narrow/);
  bad({ columns: [{ label: "x", answer: "a", narrow: "fill" }, { label: "y", answer: "b", narrow: "fill" }] }, /only one column/);
  assert.throws(() => normaliseViews([VIEW, VIEW], { forms: FORMS, workflows: WORKFLOWS }), /used twice/);
});

test("workflowEvent is the workflow's LATEST event, shown by its statusMessage; empty cells are blank", () => {
  const r = { answers: { reg: "AB12 CDE" }, workflow: { events: [
    { event: "submit", status: 200 },
    { event: "wf02", status: "pending" },
    { event: "wf03", status: "issued" },
    { event: "wf02", status: "", statusMessage: "approved by x" },
  ] } };
  assert.equal(eventText(workflowEvent(r, "wf02")), "approved by x");
  assert.equal(eventText(workflowEvent(r, "wf03")), "issued", "no statusMessage: falls back to status");
  assert.equal(workflowEvent(r, "wf01"), null);
  assert.equal(cell({ answer: "phone" }, r), "");
  assert.equal(cell({ answer: "reg" }, r), "AB12 CDE");
  assert.equal(cell({ value: () => { throw new Error("old row"); } }, r), "");
  assert.equal(cell({ value: () => "x".repeat(200) }, r).length, 80);
});

test("dateFormatters: year-first, 24-hour, in the time zone; junk comes back as given", () => {
  const { fmtDate, fmtDateTime } = dateFormatters("Europe/London");
  assert.equal(fmtDateTime("2026-09-27T12:15:00.000Z"), "2026-09-27 @ 13:15");
  assert.equal(fmtDateTime("2026-12-31T23:30:00.000Z"), "2026-12-31 @ 23:30");
  assert.equal(fmtDateTime("2026-09-27T23:30:00.000Z"), "2026-09-28 @ 00:30");
  assert.equal(fmtDate("2026-09-27T23:30:00.000Z"), "2026-09-28");
  assert.equal(fmtDateTime("nope"), "nope");
  assert.equal(fmtDate(undefined), "");
});

// ── through the Worker ──────────────────────────────────────────────────────

const admin = createAdmin({
  site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
  timeZone: "Europe/London",
  plugins: [formsPlugin({ toRecord, list: FORMS, workflows: WORKFLOWS, views: [VIEW] })],
  requireSecondFactor: false,
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

function insert(uid, outcome, answers, events = []) {
  env.FORM_DB.sqlite.prepare(`INSERT INTO submissions (uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES (?, 'parking', ?, '2026-10-01T10:00:00.000Z', 1, ?, '{"fields":[]}', ?, '{}', ?)`)
    .run(uid, `${ORIGIN}/forms/parking`, outcome, JSON.stringify(answers), JSON.stringify({ events }));
}

test("a view is one compact row per sent submission, escaped; narrow classes; workflows are a link or a named button", async () => {
  const auth = await signIn();
  insert("11111111-1111-4111-8111-111111111111", "sent",
    { reg: "<b>AB12</b>", make: "Ford", model: "Focus" }, [{ event: "wf03-issued", status: 201, statusMessage: "permit sent" }]);
  insert("22222222-2222-4222-8222-222222222222", "sent", { reg: "XY99 ZZZ", make: "Kia", model: "Rio" });
  insert("33333333-3333-4333-8333-333333333333", "invalid", {});

  let res = await call("/admin", { cookie: auth });
  const dash = await res.text();
  assert.match(dash, /Health/, "all is the dashboard as before");
  assert.doesNotMatch(dash, /aria-label="Dashboard views"/, "no view tabs");
  assert.doesNotMatch(dash, /Workflows/, "no workflows card");

  res = await call("/admin/forms", { cookie: auth });
  const idx = await res.text();
  assert.match(idx, /<h3><a href="\/admin\/forms\/views\/parking">Parking<\/a><\/h3>/, "a form with a view links to it");
  assert.match(idx, /<p class="count">2 sent of 3 submitted<\/p>/);
  assert.match(idx, /<em>newest<\/em>: 2026-10-01 @ 11:00/);

  res = await call("/admin/forms/views/parking", { cookie: auth });
  assert.equal(res.status, 200);
  const view = await res.text();
  assert.match(view, /<main class="wrap wide">/, "a data page is full width");
  assert.doesNotMatch(view, /Health/);
  assert.match(view, /<table class="compact">/);
  assert.match(view, /<th scope="col">Submitted<\/th><th scope="col" class="fill">Reg<\/th><th scope="col" class="n">Car<\/th><th scope="col" class="w">Approval<\/th>/);
  assert.match(view, /<span class="d-full">2026-10-01 @ 11:00<\/span><span class="d-short">2026-10-01<\/span>/);
  assert.match(view, /<span class="n-full">Ford \(Focus\)<\/span><span class="n-short">Ford \(…<\/span>/, "clipped to 6 on narrow");
  assert.match(view, /<td class="n"><span class="n-full">Kia \(Rio\)/, "9 characters: clipped too");
  assert.match(view, /&lt;b&gt;AB12&lt;\/b&gt;/);
  assert.doesNotMatch(view, /<b>AB12/);
  assert.match(view, /<a href="\/admin\/forms\/parking\/11111111-1111-4111-8111-111111111111#wf-wf03">permit sent<\/a>/,
    "a decorated event (wf03-issued) counts as wf03's");
  const kia = view.slice(view.indexOf("XY99"));
  assert.match(kia, /method="get" action="\/admin\/forms\/parking\/22222222-2222-4222-8222-222222222222\/run\/wf02"><button class="run" type="submit" disabled>Approval<\/button>/,
    "no run(): disabled, named after the workflow");
  assert.match(kia, /run\/wf03"><button class="run" type="submit">Permit<\/button>/);
  assert.match(view, /popovertarget="rec-11111111-1111-4111-8111-111111111111"/, "the eye button");
  assert.match(view, /<div id="rec-11111111-1111-4111-8111-111111111111" class="viewer" popover>/, "and what it opens");
  assert.doesNotMatch(view, /33333333/, "invalid rows are not in a sent view");

  assert.equal((await call("/admin/forms/views/nope", { cookie: auth })).status, 404);
  assert.equal((await call("/admin/forms/views/parking?cursor=bad", { cookie: auth })).status, 404);
});

test("the not-live banner shows on any host but site.url's, and the view names its host", async () => {
  const off = await (await call("/admin/login")).text();
  assert.match(off, /class="env-banner"/);
  assert.match(off, /Not the live site<\/strong> · localhost:8787/);
  assert.match(off, /not that on site\.example/);

  const live = await admin.fetch(new Request("https://site.example/admin/login"), env, ctx);
  assert.doesNotMatch(await live.text(), /env-banner"/);

  const auth = await signIn();
  const view = await (await call("/admin/forms/views/parking", { cookie: auth })).text();
  assert.match(view, /made on <code>localhost:8787<\/code>/);
});

test("a workflow's pages: GET starts it, its event is checked and appended, then shown", async () => {
  const auth = await signIn();
  ran.length = 0;
  insert("44444444-4444-4444-8444-444444444444", "sent", { reg: "R1" });
  const base = "/admin/forms/parking/44444444-4444-4444-8444-444444444444/run";

  let res = await call(`${base}/wf03`, { cookie: auth });
  const start = await res.text();
  assert.match(start, /<h1>WORKFLOW: Permit<\/h1>/);
  assert.match(start, /Issue a permit\?/);

  res = await call(`${base}/wf03`, { method: "POST", form: { go: "1" }, cookie: auth });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin/forms/views/parking");
  const row = env.ADMIN_DB.sqlite.prepare("SELECT * FROM workflow_events").get();
  assert.equal(row.event, "wf03-issued");
  assert.equal(row.status, 201);
  assert.equal(row.actor, "staff@example.org");
  assert.equal(row.origin, ORIGIN);

  const rec = await (await call("/admin/forms/parking/44444444-4444-4444-8444-444444444444", { cookie: auth })).text();
  assert.match(rec, /<td>wf03-issued<\/td><td>201<\/td><td>permit sent<\/td>/, "the history shows it");
  assert.match(rec, /staff@example\.org/);

  res = await call(`${base}/wf03`, { method: "POST", form: { bad: "1" }, cookie: auth });
  assert.equal(res.status, 502, "a malformed event is refused");
  assert.equal(env.ADMIN_DB.sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_events").get().n, 1, "and not logged");

  assert.equal((await call(`${base}/wf02`, { cookie: auth })).status, 409, "a placeholder");
  assert.equal((await call(`${base}/wf09`, { cookie: auth })).status, 404, "not offered on parking");
  assert.equal((await call("/admin/forms/parking/55555555-5555-4555-8555-555555555555/run/wf03", { cookie: auth })).status, 404);
  assert.equal((await call(`${base}/wf03`, { method: "POST" })).status, 403, "signed out");
});

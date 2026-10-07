import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, EVENTS_MIGRATIONS } from "./d1.js";
import { createAdmin, formsPlugin, html, scriptHash } from "../index.js";
import { mergePatch, diffPatch, changes, checkPatch, editable, activate } from "../src/patch.js";
import { checkEvent } from "../src/modules/events.js";
import { CSP } from "../src/csp.js";

// ── the patch maths ─────────────────────────────────────────────────────────

test("mergePatch: RFC 7396 - merge objects, replace the rest, null removes", () => {
  const t = { a: "b", c: { d: "e", f: "g" }, l: [1, 2] };
  assert.deepEqual(mergePatch(t, { a: "z", c: { f: null } }), { a: "z", c: { d: "e" }, l: [1, 2] });
  assert.deepEqual(mergePatch(t, { l: [3] }), { a: "b", c: { d: "e", f: "g" }, l: [3] });
  assert.deepEqual(mergePatch(t, { c: "flat" }), { a: "b", c: "flat", l: [1, 2] });
  assert.deepEqual(mergePatch({ a: "b" }, { new: { x: 1 } }), { a: "b", new: { x: 1 } });
  assert.deepEqual(t, { a: "b", c: { d: "e", f: "g" }, l: [1, 2] }, "the target is not changed");
  assert.equal(Object.getPrototypeOf(mergePatch({}, JSON.parse('{"__proto__":{"polluted":1}}'))).polluted, undefined);
});

test("diffPatch is the inverse: only what changed, null for a removed key", () => {
  const from = { answers: { reg: "AB12", make: "Ford", gone: "x" }, outcome: "sent", l: [1] };
  const to = { answers: { reg: "XY34", make: "Ford" }, outcome: "sent", l: [1, 2], added: true };
  const p = diffPatch(from, to);
  assert.deepEqual(p, { answers: { reg: "XY34", gone: null }, l: [1, 2], added: true });
  assert.deepEqual(mergePatch(from, p), to);
  assert.deepEqual(diffPatch(from, structuredClone(from)), {});
  // A null in `to` cannot be stored: the round trip shows it, so an editor can refuse it.
  assert.notDeepEqual(mergePatch(from, diffPatch(from, { ...from, outcome: null })), { ...from, outcome: null });
});

test("changes: dotted paths, with both sides", () => {
  assert.deepEqual(changes({ a: { b: 1, c: 2 }, d: 1 }, { a: { b: 1, c: 3 }, e: 1 }), [
    { path: "a.c", from: 2, to: 3 }, { path: "d", from: 1, to: undefined }, { path: "e", from: undefined, to: 1 }]);
});

test("checkPatch / checkEvent: an object, not empty, no fixed field, no prototype keys, capped", () => {
  assert.equal(checkPatch({ answers: { id: "a form field may be called id" } }), null);
  assert.match(checkPatch([]), /object/);
  assert.match(checkPatch({}), /empty/);
  assert.match(checkPatch({ id: "x" }), /cannot change id/);
  assert.match(checkPatch({ workflow: {} }), /cannot change workflow/);
  assert.match(checkPatch({ submission: {} }), /cannot change submission/);
  assert.match(checkPatch(JSON.parse('{"answers":{"__proto__":{"x":1}}}')), /__proto__/);
  assert.match(checkPatch({ answers: { x: "y".repeat(33 * 1024) } }), /at most/);
  const e = { event: "wf04-edit", timestamp: "2026-10-05T12:00:00.000Z", duration: 1, status: 200, statusMessage: "edited" };
  assert.equal(checkEvent("wf04", { ...e, patch: { answers: { reg: "X" } } }), null);
  assert.match(checkEvent("wf04", { ...e, patch: { id: "x" } }), /cannot change id/);
});

test("activate: patches in order, the latest wins; submission frozen; id and workflow kept", () => {
  const sub = { id: "u1", answers: { reg: "AB12", make: "Ford" }, outcome: "sent", workflow: { events: [] } };
  const r = structuredClone(sub);
  r.workflow.events.push({ event: "e1", patch: { answers: { reg: "XY34" } } }, { event: "e2" },
    { event: "e3", patch: { answers: { reg: "ZZ99", make: null } } });
  activate(r, structuredClone(sub));
  assert.deepEqual(r.answers, { reg: "ZZ99" });
  assert.equal(r.id, "u1");
  assert.equal(r.workflow.events.length, 3);
  assert.deepEqual(r.submission.answers, { reg: "AB12", make: "Ford" });
  assert.ok(Object.isFrozen(r.submission.answers), "the submission is immutable");
  assert.deepEqual(r.edited, ["answers.reg", "answers.make"]);
  assert.deepEqual(r.workflow.events[0].changes, [{ path: "answers.reg", from: "AB12", to: "XY34" }]);
  assert.deepEqual(r.workflow.events[2].changes, [
    { path: "answers.reg", from: "XY34", to: "ZZ99" }, { path: "answers.make", from: "Ford", to: undefined }]);
  assert.deepEqual(Object.keys(editable(r)).sort(), ["answers", "outcome"]);
});

// ── through the Worker ──────────────────────────────────────────────────────

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;
const ORIGIN = "http://localhost:8787";
const UID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});

// A test workflow: GET returns a page with a script; POST applies the posted JSON patch.
const SCRIPT = "document.body.dataset.ok = '1';";
let seen = null;
const edit = {
  id: "wf04", label: "Edit", forms: ["parking"],
  async run({ method, fields, record }) {
    seen = record;
    if (method === "GET") return { body: html`<p>editor</p>`, scripts: [SCRIPT] };
    return { event: { event: "wf04-edit", timestamp: new Date().toISOString(), duration: 0, status: 200,
      statusMessage: "edited", details: fields.get("reason"), patch: JSON.parse(fields.get("patch")) } };
  },
};

const admin = createAdmin({
  site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
  requireSecondFactor: false,
  plugins: [formsPlugin({ toRecord, list: [{ id: "parking", label: "Parking", path: "/forms/parking" }],
    workflows: [edit],
    views: [{ id: "parking", label: "Parking", form: "parking", columns: [
      { label: "Reg", answer: "reg" }, { label: "Car", value: (r) => `${r.answers.make} (${r.answers.colour})` }] }],
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
  seen = null;
  realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes("turnstile")) return Response.json({ success: true });
    throw new Error(`unexpected fetch ${u}`);
  };
  const add = env.FORM_DB.sqlite.prepare(`INSERT INTO submissions (uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES (?, 'parking', ?, '2026-10-01T10:00:00.000Z', 1, 'sent', '{"fields":[]}', ?, '{}', '{"events":[]}')`);
  add.run(UID, `${ORIGIN}/forms/parking`, JSON.stringify({ reg: "AB12 CDE", make: "Ford", colour: "Blue" }));
  add.run(OTHER, "https://other.example/forms/parking", JSON.stringify({ reg: "OTHER 1", make: "Kia", colour: "Red" }));
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
const RUN = `/admin/forms/parking/${UID}/run/wf04`;
const patchRows = () => env.ADMIN_DB.sqlite.prepare("SELECT patch, details, actor FROM workflow_events ORDER BY id").all().map((r) => ({ ...r }));

test("an edit is ONE event with a patch; the submission is never written; every reader sees active", async () => {
  const auth = await signIn();
  const before = env.FORM_DB.sqlite.prepare("SELECT answers FROM submissions WHERE uid = ?").get(UID).answers;

  let res = await call(RUN, { method: "POST", cookie: auth,
    form: { reason: "phoned", patch: JSON.stringify({ answers: { reg: "<script>x</script>", colour: "Red" }, outcome: "moved", url: "https://other.example/x" }) } });
  assert.equal(res.status, 303);
  assert.deepEqual(patchRows(), [{ patch: '{"answers":{"reg":"<script>x</script>","colour":"Red"},"outcome":"moved","url":"https://other.example/x"}',
    details: "phoned", actor: "staff@example.org" }]);
  assert.equal(env.FORM_DB.sqlite.prepare("SELECT answers FROM submissions WHERE uid = ?").get(UID).answers, before, "FORM_DB untouched");

  const view = await (await call("/admin/forms/views/parking", { cookie: auth })).text();
  assert.match(view, /&lt;script&gt;x&lt;\/script&gt; <span class="edited" title="Edited\. Submitted: AB12 CDE">/, "active, escaped, marked");
  assert.match(view, /Ford \(Red\) <span class="edited" title="Edited\. Submitted: Ford \(Blue\)">/, "a value column is marked too");
  assert.doesNotMatch(view, /<script>x/);
  assert.doesNotMatch(view, /OTHER 1/, "an edited url does not move a record between origins");

  const rec = await (await call(`/admin/forms/parking/${UID}`, { cookie: auth })).text();
  assert.match(rec, /Outcome <strong>moved<\/strong>/);
  assert.match(rec, /<strong>Edited\.<\/strong> This is the ACTIVE record/);
  assert.match(rec, /Submitted: AB12 CDE<\/span>/);
  assert.match(rec, /<li><code>answers\.reg<\/code>: AB12 CDE &rarr; &lt;script&gt;x&lt;\/script&gt;<\/li>/, "history: old -> new");
  assert.match(rec, /<h3>Submission<\/h3><pre>/);
  assert.doesNotMatch(rec, /<script>x/);

  await call(RUN, { cookie: auth });
  assert.equal(seen.answers.reg, "<script>x</script>", "a workflow is given the active record");
  assert.equal(seen.submission.answers.reg, "AB12 CDE", "and the submission, frozen");
  assert.ok(Object.isFrozen(seen.submission));

  const list = await (await call("/admin/forms/parking?outcome=sent", { cookie: auth })).text();
  assert.match(list, /moved/, "the listing still selects on the submission's outcome, and shows the active one");
});

test("a fixed field in a patch is refused and nothing is logged", async () => {
  const auth = await signIn();
  const res = await call(RUN, { method: "POST", cookie: auth, form: { reason: "x", patch: '{"id":"evil"}' } });
  assert.equal(res.status, 502);
  assert.equal(patchRows().length, 0);
});

test("scripts: inlined, allowed by their hash on that page only", async () => {
  const auth = await signIn();
  const res = await call(RUN, { cookie: auth });
  const page = await res.text();
  assert.match(page, /<script>document\.body\.dataset\.ok = '1';<\/script>/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, new RegExp(`script-src ${(await scriptHash(SCRIPT)).replace(/[+/]/g, "\\$&")} https://challenges\\.cloudflare\\.com;`));
  assert.equal(csp.replace(/script-src [^;]+/, ""), CSP.replace(/script-src [^;]+/, ""), "nothing else in the CSP changes");
  const other = await call(`/admin/forms/parking/${UID}`, { cookie: auth });
  assert.equal(other.headers.get("content-security-policy"), CSP);
  assert.doesNotMatch(CSP, /sha256/);
});

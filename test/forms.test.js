import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.js";
import { select, originPattern, formStats, listSubmissions, getSubmission, decodeCursor } from "../src/modules/forms.js";

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;

// The shape cf-form-mailer's toRecord returns for schema_version 1.
const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});

let n = 0;
function insert(db, { form = "parking", url = "https://site.example/forms/parking", outcome = "sent", answers = { name: "A" } } = {}) {
  n++;
  db.sqlite.prepare(`INSERT INTO submissions (uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES (?, ?, ?, ?, 1, ?, '{"fields":[]}', ?, '{}', '{"events":[]}')`)
    .run(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, form, url,
      new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), outcome, JSON.stringify(answers));
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("select refuses anything but one SELECT", () => {
  const db = fakeD1(SCHEMA);
  assert.throws(() => select(db, "DELETE FROM submissions"));
  assert.throws(() => select(db, "SELECT 1; DELETE FROM submissions"));
  assert.throws(() => select(db, "UPDATE submissions SET outcome='x'"));
  assert.doesNotThrow(() => select(db, "SELECT 1"));
});

test("originPattern escapes LIKE wildcards", () => {
  assert.equal(originPattern("https://a_b.example"), "https://a\\_b.example/%");
  assert.equal(originPattern("http://localhost:8787"), "http://localhost:8787/%");
});

test("only rows posted on the same origin are counted, listed or fetched", async () => {
  const db = fakeD1(SCHEMA);
  insert(db);
  insert(db, { outcome: "honeypot", answers: {} });
  const other = insert(db, { url: "https://staging.site.example/forms/parking" });
  insert(db, { url: "https://siteXexample/forms/parking" });           // _ / . lookalike
  insert(db, { url: "https://site.example.evil.test/forms/parking" }); // prefix lookalike
  insert(db, { form: "contact", url: "https://site.example/forms/contact" });

  const s = await formStats(db, "parking", "https://site.example");
  assert.equal(s.total, 2);
  assert.deepEqual(Object.keys(s.outcomes).sort(), ["honeypot", "sent"]);
  assert.equal(s.latest.outcome, "honeypot");

  const page = await listSubmissions(db, { formId: "parking", origin: "https://site.example", toRecord });
  assert.equal(page.records.length, 2);
  assert.ok(page.records.every((r) => r.url.startsWith("https://site.example/")));
  assert.equal(await getSubmission(db, { formId: "parking", origin: "https://site.example", uid: other, toRecord }), null);
  assert.ok(await getSubmission(db, { formId: "parking", origin: "https://staging.site.example", uid: other, toRecord }));
});

test("paging is newest first, with an opaque cursor", async () => {
  const db = fakeD1(SCHEMA);
  for (let i = 0; i < 5; i++) insert(db);
  const origin = "https://site.example";
  const p1 = await listSubmissions(db, { formId: "parking", origin, toRecord, limit: 2 });
  const p2 = await listSubmissions(db, { formId: "parking", origin, toRecord, limit: 2, cursor: p1.next });
  const p3 = await listSubmissions(db, { formId: "parking", origin, toRecord, limit: 2, cursor: p2.next });
  const ts = [...p1.records, ...p2.records, ...p3.records].map((r) => r.timestamp);
  assert.equal(ts.length, 5);
  assert.deepEqual(ts, [...ts].sort().reverse());
  assert.equal(p3.next, null);
  assert.equal(decodeCursor("garbage"), null);
  await assert.rejects(listSubmissions(db, { formId: "parking", origin, toRecord, cursor: "garbage" }), RangeError);
  await assert.rejects(listSubmissions(db, { formId: "parking", origin, toRecord, outcome: "x'; --" }), RangeError);
});

test("outcome filter", async () => {
  const db = fakeD1(SCHEMA);
  insert(db); insert(db, { outcome: "invalid", answers: {} });
  const p = await listSubmissions(db, { formId: "parking", origin: "https://site.example", outcome: "invalid", toRecord });
  assert.deepEqual(p.records.map((r) => r.outcome), ["invalid"]);
});

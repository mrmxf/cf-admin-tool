import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS, EVENTS_MIGRATIONS } from "./d1.js";
import { createAdmin, formsPlugin } from "../index.js";
import { approvalWorkflow, PREVIEW_SCRIPT } from "../src/approval.js";
import { sendMail } from "../src/deliver.js";
import { scriptHash } from "../src/csp.js";
import { renderMarkdown, markdownText, fill } from "../src/markdown.js";
import { FORMS_TEMPLATES } from "../src/plugins/forms-templates.js";
import { checkEvent } from "../src/modules/events.js";

// ── Markdown ────────────────────────────────────────────────────────────────

test("markdown: the subset, and nothing typed becomes markup", () => {
  assert.equal(renderMarkdown("# Hi\n\nOne *two* **three** _four_\nnext line\n\n- a\n- b"),
    "<h1>Hi</h1>\n<p>One <em>two</em> <strong>three</strong> <em>four</em> next line</p>\n<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("[site](https://x.test/?a=1&b=2)"), '<p><a href="https://x.test/?a=1&amp;b=2">site</a></p>');
  assert.equal(renderMarkdown("[bad](javascript:alert(1))"), "<p>[bad](javascript:alert(1))</p>", "only http, https, mailto");
  assert.equal(renderMarkdown(`<script>alert("x")</script>`), "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  assert.equal(renderMarkdown("x", { p: 'margin:0"><b' }), '<p style="margin:0&quot;&gt;&lt;b">x</p>');
});

test("markdown: a newline is a space; a blank line, \\ or two spaces is the break", () => {
  assert.equal(renderMarkdown("one\ntwo\r\n  three\n\nnext"), "<p>one two three</p>\n<p>next</p>");
  assert.equal(renderMarkdown("one\\\ntwo  \nthree"), "<p>one<br>two<br>three</p>");
  assert.equal(renderMarkdown("**across\nlines**"), "<p><strong>across lines</strong></p>");
  assert.equal(renderMarkdown("a\\\\\nb"), "<p>a\\ b</p>", "an escaped backslash is not a break");
});

test("markdown: blocks need no blank line before them", () => {
  assert.equal(renderMarkdown("Intro:\n- a\n  more\n- b\n\nEnd"), "<p>Intro:</p>\n<ul><li>a more</li><li>b</li></ul>\n<p>End</p>");
  assert.equal(renderMarkdown("# T\nbody\n---\n> q1\nq2"), "<h1>T</h1>\n<p>body</p>\n<hr>\n<blockquote>q1 q2</blockquote>");
  assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderMarkdown("3. a"), '<ol start="3"><li>a</li></ol>');
  assert.equal(renderMarkdown("since\n2026. The next"), "<p>since 2026. The next</p>", "only a 1. interrupts a paragraph");
  assert.equal(renderMarkdown("since\n1. a"), "<p>since</p>\n<ol><li>a</li></ol>");
});

test("markdown: the inline extensions, and the styles they carry", () => {
  assert.equal(renderMarkdown("2^nd^ H~2~O ~~gone~~"), "<p>2<sup>nd</sup> H<sub>2</sub>O <del>gone</del></p>");
  assert.equal(renderMarkdown("~5 mins to ~10 and 2^3 ^4"), "<p>~5 mins to ~10 and 2^3 ^4</p>", "no spaces inside sup or sub");
  assert.equal(renderMarkdown("x^2^", { sup: "font-size:.75em" }), '<p>x<sup style="font-size:.75em">2</sup></p>');
  assert.equal(renderMarkdown("[a](https://x.test/~me/~you/_b_/)"), '<p><a href="https://x.test/~me/~you/_b_/">a</a></p>', "a URL is never read as markup");
  assert.equal(renderMarkdown(String.raw`[a](https://x.test/\_b)`), '<p><a href="https://x.test/_b">a</a></p>', "a literal inside a URL");
  assert.equal(renderMarkdown("^<b>^ ~<i>~"), "<p><sup>&lt;b&gt;</sup> <sub>&lt;i&gt;</sub></p>", "still escaped");
  assert.equal(renderMarkdown("x\uE0000\uE001 [a](https://x.test)"), '<p>x0 <a href="https://x.test">a</a></p>', "typed placeholders cannot reach the stash");
});

test("markdownText: the plain-text part, line for line, without the markers", () => {
  assert.equal(markdownText("**Bold** *em* _em_ x^2^ H~2~O ~~old~~"), "Bold em em x2 H2O ~~old~~");
  assert.equal(markdownText("[Map](https://x.test/m)\n[https://x.test](https://x.test)\n[bad](javascript:x)"),
    "Map (https://x.test/m)\nhttps://x.test\n[bad](javascript:x)");
  assert.equal(markdownText("one\\\ntwo  \nJ\\_Smith \\*"), "one\ntwo\nJ_Smith *");
});

test("fill: every marker in an answer is literal, wherever it lands", () => {
  for (const answer of ["x^2^", "H~2~O", "~~gone~~", "> quote", "---", "1. first", "- item", "# head"]) {
    const html = renderMarkdown(fill("{{a}}", { a: answer }));
    assert.equal(html, `<p>${answer.replace(">", "&gt;")}</p>`, answer);
  }
});

test("fill: answers are made literal Markdown; unknown names stay visible", () => {
  const md = fill("Dear {{name}}, {{missing}}", { name: "**Eve** [x](https://evil.test)" });
  assert.equal(md, "Dear \\*\\*Eve\\*\\* \\[x\\](https://evil.test), {{missing}}");
  assert.equal(renderMarkdown(md), "<p>Dear **Eve** [x](https://evil.test), {{missing}}</p>");
  assert.equal(fill("Re: {{name}}", { name: "*A*" }, String), "Re: *A*");
});

test("checkEvent: the five required fields, and the event must be the workflow's", () => {
  const ok = { event: "wf02-approve", timestamp: "2026-09-27T12:00:00.000Z", duration: 12, status: 201, statusMessage: "✅ with mail" };
  assert.equal(checkEvent("wf02", ok), null);
  assert.equal(checkEvent("wf02", { ...ok, event: "wf02" }), null);
  assert.match(checkEvent("wf02", { ...ok, event: "wf03-approve" }), /must be "wf02"/);
  assert.match(checkEvent("wf02", { ...ok, event: "wf020" }), /must be "wf02"/);
  assert.match(checkEvent("wf02", { ...ok, duration: 1.5 }), /duration/);
  assert.match(checkEvent("wf02", { ...ok, status: 999 }), /HTTP status/);
  assert.match(checkEvent("wf02", { ...ok, statusMessage: " " }), /statusMessage/);
  assert.match(checkEvent("wf02", { ...ok, timestamp: "soon" }), /timestamp/);
});

// ── the approval workflow, through the Worker ───────────────────────────────

const SCHEMA = new URL("fixtures/submissions.sql", import.meta.url).pathname;
const ORIGIN = "http://localhost:8787";
const UID = "11111111-1111-4111-8111-111111111111";
const THEME = Object.fromEntries(["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"].map((k) => [k, "oklch(50% 0 0)"]));
const toRecord = (r) => ({
  id: r.uid, form: r.form, url: r.url, timestamp: r.timestamp, schemaVersion: r.schemaVersion,
  outcome: r.outcome, formMeta: JSON.parse(r.formMeta), answers: JSON.parse(r.answers),
  session: JSON.parse(r.session), workflow: JSON.parse(r.workflow),
});

const admin = createAdmin({
  site: { name: "Test Site", url: "https://site.example", lang: "en-GB", fonts: {}, theme: { dark: THEME } },
  requireSecondFactor: false,
  plugins: [formsPlugin({ toRecord, list: [{ id: "parking", label: "Parking", path: "/forms/parking" }],
  workflows: [approvalWorkflow({
    id: "wf02", label: "Parking approval", forms: ["parking"], replyToVar: "PARKING_RECIPIENT", ccVar: "PARKING_RECIPIENT",
    templates: {
      approve: { subject: "Approved: {{reg}}", body: "Dear {{name}},\n\nYour car **{{reg}}** is approved for {{site_name}}." },
      deny: { subject: "Sorry: {{reg}}", body: "Dear {{name}}, no." },
    },
  })],
  views: [{ id: "parking", label: "Parking", form: "parking", columns: [
    { label: "Reg", answer: "reg" }, { label: "Approval", workflow: "wf02" }] }],
  })],
});

let env, logs, realFetch, realLog, pending, mailtrap;
beforeEach(() => {
  env = {
    ADMIN_DB: fakeD1(AUTH_MIGRATIONS, ...EVENTS_MIGRATIONS), FORM_DB: fakeD1(SCHEMA),
    ADMIN_USERS: JSON.stringify([{ email: "staff@example.org" }]),
    DRY_RUN: "true", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret",
    ADMIN_SENDER: "no-reply@site.example", PARKING_RECIPIENT: "parking@site.example",
  };
  logs = [];
  pending = [];
  mailtrap = [];
  realLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes("turnstile")) return Response.json({ success: true });
    if (String(u).includes("mailtrap")) {
      mailtrap.push(JSON.parse(init.body));
      return new Response("down", { status: 500 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  env.FORM_DB.sqlite.prepare(`INSERT INTO submissions (uid, form, url, timestamp, schema_version, outcome, form_meta, answers, session, workflow)
    VALUES (?, 'parking', ?, '2026-10-01T10:00:00.000Z', 1, 'sent', '{"fields":[]}', ?, '{}', '{"events":[]}')`)
    .run(UID, `${ORIGIN}/forms/parking`, JSON.stringify({ name: "Jo <b>Bloggs</b>", reg: "AB12 CDE", email: "jo@example.org" }));
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
const RUN = `/admin/forms/parking/${UID}/run/wf02`;
const events = () => env.ADMIN_DB.sqlite.prepare("SELECT event, status, status_message AS m, details, duration FROM workflow_events ORDER BY id").all()
  .map((r) => ({ ...r }));

test("approve: the submission, then the filled template and its preview, then send -> 201", async () => {
  const auth = await signIn();
  const view = await (await call("/admin/forms/views/parking", { cookie: auth })).text();
  assert.match(view, /run\/wf02"><button class="run" type="submit">Parking approval<\/button>/, "enabled: it has a run()");

  let res = await call(RUN, { cookie: auth });
  const start = await res.text();
  assert.match(start, /<h1>WORKFLOW: Parking approval<\/h1>/);
  assert.match(start, /<th scope="row">Reg<\/th><td class="wrap-text">AB12 CDE<\/td>/, "the submission, as its view shows it");
  assert.match(start, /name="decision" value="approve">Approve<\/button>/);
  assert.match(start, /name="decision" value="deny" class="secondary">Deny<\/button>/);
  const started = start.match(/name="started" value="([^"]+)"/)[1];

  res = await call(RUN, { method: "POST", cookie: auth, form: { step: "decide", decision: "approve", started } });
  const respond = await res.text();
  assert.match(respond, /Send response to submitter/);
  assert.match(respond, /<dd>jo@example\.org<\/dd>/);
  assert.match(respond, /<dd>Approved: AB12 CDE<\/dd>/);
  assert.match(respond, /name="markdown" value="Dear Jo &lt;b&gt;Bloggs&lt;\/b&gt;,\n\nYour car \*\*AB12 CDE\*\* is approved for Test Site\.">/,
    "filled before it is shown; escaped in the hidden field");
  assert.doesNotMatch(respond, /<textarea/, "the preview first: no editor");
  assert.match(respond, /<strong>AB12 CDE<\/strong>/, "the preview is rendered");
  assert.doesNotMatch(respond, /<b>Bloggs/, "an answer never becomes markup");
  assert.match(respond, /mail-preview[\s\S]*value="edit" class="secondary">Edit<\/button>[\s\S]*value="send">Send<\/button>[\s\S]*value="skip" class="secondary">Don't send<\/button>[\s\S]*value="back" class="secondary">Back<\/button>/,
    "the preview, Edit below it, then the actions");
  assert.doesNotMatch(respond, /value="preview"/);

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "edit", markdown: "Now *edited* <i>x</i>" } });
  const editing = await res.text();
  assert.match(editing, />Now \*edited\* &lt;i&gt;x&lt;\/i&gt;<\/textarea>/, "Edit: the text in the editor");
  assert.match(editing, /id="markdown-help"/);
  assert.match(editing, /value="preview">Preview<\/button>/);
  assert.doesNotMatch(editing, /value="(send|skip|back|edit)"|class="mail-preview"/, "only Preview in the editor");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "preview", markdown: "Now *edited* <i>x</i>" } });
  const previewed = await res.text();
  assert.match(previewed, /<em>edited<\/em> &lt;i&gt;x&lt;\/i&gt;/, "the preview shows the text as typed");
  assert.match(previewed, /name="markdown" value="Now \*edited\* &lt;i&gt;x&lt;\/i&gt;">/, "and the text is kept");
  assert.match(previewed, /value="send">Send<\/button>/, "with the actions back");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "nonsense", markdown: "x" } });
  assert.equal(res.status, 200, "an unknown action records nothing");
  assert.equal(events().length, 0, "nothing recorded yet");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "send", markdown: "Edited **text**" } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/admin/forms/views/parking");
  const [e] = events();
  assert.deepEqual({ event: e.event, status: e.status, m: e.m }, { event: "wf02-approve", status: 201, m: "✅ with mail" });
  assert.ok(Number.isInteger(e.duration) && e.duration >= 0);
  const mail = logs.find((l) => l.includes("DRY RUN workflow email"));
  assert.match(mail, /To: jo@example\.org/);
  assert.match(mail, /Reply-To: parking@site\.example/);
  assert.match(mail, /Subject: Approved: AB12 CDE/);
  assert.match(mail, /Edited text/, "the plain-text part: what was typed, without the markers");

  const after = await (await call("/admin/forms/views/parking", { cookie: auth })).text();
  assert.match(after, /#wf-wf02">✅ with mail<\/a>/, "the table shows the latest event");
  assert.match(after, /<td class="eye"><span class="badge" role="img" aria-label="Parking approval: ✅ with mail" title="Parking approval: ✅ with mail"><small>✅<\/small><\/span><button/,
    "approvalWorkflow's default badge, beside the eye");
});

test("page 2: the cc box (ticked to start, then as sent, kept through the editor), and no script", async () => {
  const auth = await signIn();
  const started = new Date().toISOString();
  let res = await call(RUN, { method: "POST", cookie: auth, form: { step: "decide", decision: "approve", started } });
  const page = await res.text();
  assert.match(page, /<input type="checkbox" name="cc" value="1" checked> cc: parking@site\.example<\/label>[\s\S]*value="send">Send/,
    "ticked to start, above the buttons");
  assert.doesNotMatch(page, /<script>/, "the toggle needs no script");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "edit", markdown: "x", cc: "1" } });
  const editing = await res.text();
  assert.match(editing, /<label for="markdown">Message \(you can customise this markdown\)<\/label>/);
  assert.match(editing, /<input type="hidden" name="cc" value="1">/, "ticked rides hidden through the editor");
  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "edit", markdown: "x" } });
  assert.doesNotMatch(await res.text(), /name="cc"/, "unticked: nothing to carry");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "preview", markdown: "x" } });
  assert.match(await res.text(), /<input type="checkbox" name="cc" value="1"> cc:/, "unticked stays unticked across a preview");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "send", markdown: "x", cc: "1" } });
  assert.equal(res.status, 303);
  assert.match(logs.findLast((l) => l.includes("DRY RUN workflow email")), /\nCc: parking@site\.example\n/);
  assert.equal(events().at(-1).details, "cc: parking@site.example", "the cc is on the record");

  res = await call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision: "approve", started, action: "send", markdown: "y" } });
  assert.match(logs.findLast((l) => l.includes("DRY RUN workflow email")), /\nCc: \n/, "unticked: no cc");
  assert.equal(events().at(-1).details, "");
});

test("approval page: the syntax note, and no Send without an address", async () => {
  const c = { site: { name: "S", url: "https://x.test" } };
  const page = (to, mode) => String(FORMS_TEMPLATES.approvalRespond(c, { action: "/a", decision: "approve", started: "2026-01-01T00:00:00.000Z", to,
    subject: "s", markdown: "m", preview: "p", mode }));
  assert.match(page("a@x.test"), /value="send">Send<\/button>/);
  assert.match(page("a@x.test", "edit"), /id="markdown-help">[\s\S]*\^sup\^[\s\S]*~sub~/);
  assert.match(page("a@x.test", "edit"), /aria-describedby="markdown-help"/);
  assert.doesNotMatch(page(""), /value="send"/);
  assert.match(page(""), /value="skip"/, "Don't send is still offered");
});

test("sendMail: a cc that does not look right is dropped", async () => {
  const sent = [];
  globalThis.fetch = async (u, init) => { sent.push(JSON.parse(init.body)); return new Response("{}"); };
  const base = { env: { MAILTRAP_API_TOKEN: "t" }, request: new Request("https://site.example/"), from: "a@site.example",
    to: "jo@example.org", subject: "s", text: "t", html: "h" };
  await sendMail({ ...base, cc: "ok@site.example" });
  await sendMail({ ...base, cc: "bad\r\nBcc: x@evil.example" });
  assert.deepEqual(sent.map((p) => p.cc), [[{ email: "ok@site.example" }], undefined]);
});

test("the four outcomes, Back, and a failed send logged as 500 with its details", async () => {
  const auth = await signIn();
  const started = new Date(Date.now() - 1500).toISOString();
  const respond = (decision, action) => call(RUN, { method: "POST", cookie: auth,
    form: { step: "respond", decision, started, action, markdown: "x" } });

  await respond("approve", "skip");
  await respond("deny", "send");
  await respond("deny", "skip");
  assert.deepEqual(events().map((e) => [e.event, e.status, e.m]), [
    ["wf02-approve", 202, "✅ silent"], ["wf02-deny", 400, "❌ with mail"], ["wf02-deny", 422, "❌ silent"]]);
  assert.ok(events()[0].duration >= 1500, "duration runs from the start page");

  const back = await respond("approve", "back");
  assert.equal(back.status, 200);
  assert.match(await back.text(), /value="approve">Approve<\/button>/, "Back is page 1 again");
  assert.equal(events().length, 3, "and records nothing");

  env.DRY_RUN = "false";
  env.MAILTRAP_API_TOKEN = "t";
  const failed = await respond("approve", "send");
  assert.equal(failed.status, 502);
  const page = await failed.text();
  assert.match(page, /The email was not sent \(the mail service answered 500\)\. That has been logged/);
  assert.match(page, /value="send">Send<\/button>/, "page 2 again, to try again");
  assert.equal(mailtrap.length, 1);
  assert.equal(mailtrap[0].to[0].email, "jo@example.org");
  assert.match(mailtrap[0].html, /^<!doctype html>/);
  const last = events().at(-1);
  assert.deepEqual([last.event, last.status, last.m, last.details],
    ["wf02-approve", 500, "☠️ failed", "send failed: the mail service answered 500"]);

  const rec = await (await call(`/admin/forms/parking/${UID}`, { cookie: auth })).text();
  assert.match(rec, /Latest: ☠️ failed/);
  assert.match(rec, /run\/wf02"><button class="run" type="submit">Parking approval<\/button>/, "the submission page can run it again");
  assert.match(rec, /☠️ failed<br><span class="meta">send failed: the mail service answered 500<\/span>/, "history shows the details");
});

// ── sendMail: attachments ───────────────────────────────────────────────────

test("sendMail: attachments reach Mailtrap as given; none means no field; a dry run names them", async () => {
  const att = { filename: "a.png", type: "image/png", disposition: "inline", content_id: "a", content: "AAAA" };
  const base = { env: { MAILTRAP_API_TOKEN: "t" }, request: new Request("https://x.test/"), from: "f@x.test", fromName: "F", to: "t@x.test", subject: "s", text: "t", html: "<p>h</p>" };
  await sendMail({ ...base, attachments: [att] });
  assert.deepEqual(mailtrap.at(-1).attachments, [att]);
  await sendMail(base);
  assert.equal("attachments" in mailtrap.at(-1), false);
  const dry = await sendMail({ ...base, env: { DRY_RUN: "true" }, request: new Request("http://localhost:8799/"), attachments: [att] });
  assert.equal(dry.dryRun, true);
  assert.ok(logs.some((l) => /Attachments: a\.png/.test(l)));
});

test("markdownHelp: the literal backslash survives the template", () => {
  assert.match(String(FORMS_TEMPLATES.approvalRespond({}, { action: "/a", decision: "approve", started: "s", to: "", subject: "", markdown: "", preview: "", mode: "edit" })), /<code>\\<\/code> = line break/);
});

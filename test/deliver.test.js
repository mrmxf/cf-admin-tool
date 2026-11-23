// The login email's subject: the code leads it only when the consumer opts in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeSubject, sendEmailCode, sendMail, mailProvider } from "../src/deliver.js";
import { coreFlags, coreChecks } from "../src/modules/health.js";

const SITE = { name: "Test Site" };

test("codeSubject: the plain subject by default, the code first only on opt-in", () => {
  assert.equal(codeSubject(SITE, "123456"), "Test Site admin login code");
  assert.equal(codeSubject(SITE, "123456", true), "123456 is your Test Site code");
  assert.equal(codeSubject({ name: "Evil\r\nBcc: x@y" }, "123456", true), "123456 is your Evil Bcc: x@y code", "no header break");
});

test("sendEmailCode puts the chosen subject on the Mailtrap request", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}"); };
  try {
    const base = { env: { MAILTRAP_API_TOKEN: "t", ADMIN_SENDER: "a@example.org" }, site: SITE,
      request: new Request("https://site.example/admin/login"), to: "s@example.org", code: "654321", minutes: 10, secondFactor: false };
    await sendEmailCode(base);
    await sendEmailCode({ ...base, codeInSubject: true });
    assert.deepEqual(sent.map((b) => b.subject), ["Test Site admin login code", "654321 is your Test Site code"]);
    assert.match(sent[1].text, /654321/, "the body still has it");
  } finally { globalThis.fetch = realFetch; }
});

/** Run fn with fetch recorded; returns [{url, headers, body}]. */
async function capture(fn, status = 200) {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response("{}", { status }); };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return sent;
}

const REQ = new Request("https://site.example/admin/login");

test("mailProvider: Brevo wins when its key is set, then Mailtrap, else none", () => {
  assert.equal(mailProvider({ BREVO_API_KEY: "b", MAILTRAP_API_TOKEN: "m" }), "brevo");
  assert.equal(mailProvider({ MAILTRAP_API_TOKEN: "m" }), "mailtrap");
  assert.equal(mailProvider({}), null);
});

test("sendEmailCode through Brevo: its URL, api-key header and field names", async () => {
  const sent = await capture(() => sendEmailCode({ env: { BREVO_API_KEY: "bk", ADMIN_SENDER: "a@example.org" }, site: SITE,
    request: REQ, to: "s@example.org", code: "111222", minutes: 10, secondFactor: false }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(sent[0].headers["api-key"], "bk");
  assert.equal(sent[0].headers["Api-Token"], undefined);
  const b = sent[0].body;
  assert.deepEqual(b.sender, { email: "a@example.org", name: "Test Site admin" });
  assert.deepEqual(b.to, [{ email: "s@example.org" }]);
  assert.equal(b.subject, "Test Site admin login code");
  assert.match(b.textContent, /111222/);
  assert.deepEqual(b.tags, ["admin-login"]);
  assert.equal(b.from, undefined, "no Mailtrap field names");
});

test("sendEmailCode: a Brevo error is reported, not thrown", async () => {
  let r;
  await capture(async () => { r = await sendEmailCode({ env: { BREVO_API_KEY: "bk", ADMIN_SENDER: "a@example.org" }, site: SITE,
    request: REQ, to: "s@example.org", code: "1", minutes: 10 }); }, 401);
  assert.deepEqual(r, { ok: false, reason: "brevo 401" });
});

test("sendEmailCode with no provider sends nothing", async () => {
  let r;
  const sent = await capture(async () => { r = await sendEmailCode({ env: { ADMIN_SENDER: "a@example.org" }, site: SITE,
    request: REQ, to: "s@example.org", code: "1", minutes: 10 }); });
  assert.equal(sent.length, 0);
  assert.equal(r.ok, false);
});

test("sendMail maps cc, replyTo, html and attachments for each provider", async () => {
  const args = { request: REQ, from: "a@example.org", fromName: "Site", to: "s@example.org", cc: "c@example.org",
    replyTo: "r@example.org", subject: "Hi", text: "t", html: "<p>h</p>", category: "wf",
    attachments: [{ filename: "x.png", type: "image/png", content: "QUJD", disposition: "inline", content_id: "x" }] };
  const [brevo] = await capture(() => sendMail({ ...args, env: { BREVO_API_KEY: "bk" } }));
  assert.equal(brevo.url, "https://api.brevo.com/v3/smtp/email");
  assert.deepEqual(brevo.body, {
    sender: { email: "a@example.org", name: "Site" }, to: [{ email: "s@example.org" }], subject: "Hi",
    textContent: "t", htmlContent: "<p>h</p>", tags: ["wf"], cc: [{ email: "c@example.org" }],
    replyTo: { email: "r@example.org" }, attachment: [{ name: "x.png", content: "QUJD" }],
  });
  const [mt] = await capture(() => sendMail({ ...args, env: { MAILTRAP_API_TOKEN: "mt" } }));
  assert.equal(mt.url, "https://send.api.mailtrap.io/api/send");
  assert.equal(mt.headers["Api-Token"], "mt");
  assert.deepEqual(mt.body, {
    from: { email: "a@example.org", name: "Site" }, to: [{ email: "s@example.org" }], subject: "Hi", text: "t",
    category: "wf", html: "<p>h</p>", cc: [{ email: "c@example.org" }], headers: { "Reply-To": "r@example.org" },
    attachments: args.attachments,
  });
});

test("health: mail is configured by either provider, and names it", async () => {
  const flags = async (env) => (await coreFlags({ ADMIN_SENDER: "a@example.org", ...env })).mailConfigured;
  assert.equal(await flags({ BREVO_API_KEY: "b" }), true);
  assert.equal(await flags({ MAILTRAP_API_TOKEN: "m" }), true);
  assert.equal(await flags({}), false);
  const mail = async (env) => (await coreChecks({ ADMIN_SENDER: "a@example.org", ...env })).find((c) => c.name.startsWith("Login email"));
  assert.deepEqual(await mail({ BREVO_API_KEY: "b" }), { name: "Login email (Brevo)", ok: true, detail: "a@example.org" });
  assert.equal((await mail({})).ok, false);
});

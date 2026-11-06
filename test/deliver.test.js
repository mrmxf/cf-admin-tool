// The login email's subject: the code leads it only when the consumer opts in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeSubject, sendEmailCode } from "../src/deliver.js";

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

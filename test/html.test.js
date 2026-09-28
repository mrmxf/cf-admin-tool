import { test } from "node:test";
import assert from "node:assert/strict";
import { html, raw } from "../src/html.js";

test("interpolations are escaped", () => {
  const evil = `<script>alert("x")</script>'`;
  assert.equal(String(html`<p title="${evil}">${evil}</p>`),
    `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;</p>`);
});

test("nested html and arrays pass through once, raw opts out", () => {
  const items = ["<a>", "b"].map((s) => html`<li>${s}</li>`);
  assert.equal(String(html`<ul>${items}</ul>${raw("<hr>")}`), "<ul><li>&lt;a&gt;</li><li>b</li></ul><hr>");
});

test("null, undefined and false render as nothing; 0 does not", () => {
  assert.equal(String(html`${null}${undefined}${false}${0}`), "0");
});

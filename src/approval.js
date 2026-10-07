/**
 * approvalWorkflow(options) -> a workflow: approve or deny a submission, then
 * optionally email the submitter a response written from a Markdown template.
 *
 *   approvalWorkflow({
 *     id: "wf02", label: "Parking approval", forms: ["parking"],
 *     emailField: "email",                       // the answer to reply to
 *     templates: { approve: { subject, body }, deny: { subject, body } },
 *     senderVar: "ADMIN_SENDER",                 // env var: From: (default)
 *     replyToVar: "PARKING_RECIPIENT",           // env var: Reply-To: (optional)
 *     ccVar: "PARKING_RECIPIENT",                // env var: an optional Cc:, a checkbox (optional)
 *     badge, badgeRank,                          // default: ✅ approved, ❌ denied, rank 0 (workflows.js)
 *   })
 *
 * Templates are Markdown (see markdown.js). "{{field}}" is filled from the
 * submission's answers, plus {{site_name}}, {{site_url}} and {{submitted_date}},
 * BEFORE the text is shown; the admin can still edit it.
 *
 * Pages, each "WORKFLOW: <label>":
 *   GET          the submission, [Approve] [Deny]            (the start time is set here)
 *   POST decide  the response: Markdown, a light-mode preview,
 *                [x] cc: <ccVar's address>     (only with ccVar set; checked to start)
 *                [Send] [Don't send] [Update preview] [Back]
 *                "Update preview" is disabled until the text is edited (a script,
 *                by hash; without it the button simply stays enabled).
 *   POST respond send    -> email, then the event   201 "✅ with mail" / 400 "❌ with mail"
 *                skip    -> the event, no email     202 "✅ silent"    / 422 "❌ silent"
 *                preview -> page 2 again, previewing the text as typed; nothing recorded
 *                back    -> page 1 again (same start time); nothing recorded
 * A send with the cc box ticked records "cc: <address>" in the event's `details`.
 * A failed send logs 500 "☠️ failed" with the reason in `details`, and shows
 * page 2 again with the text kept, to try again or not send.
 */

import { fill, escapeMd, renderMarkdown } from "./markdown.js";
import { sendMail } from "./deliver.js";

export const OUTCOMES = {
  approve: { send: [201, "✅ with mail"], skip: [202, "✅ silent"] },
  deny: { send: [400, "❌ with mail"], skip: [422, "❌ silent"] },
};
export const FAILED = [500, "☠️ failed"];
export const APPROVAL_BADGE = { 201: "✅", 202: "✅", 400: "❌", 422: "❌" };

// Page 2: "Update preview" waits for an edit, so an edit asks for a preview.
// Rendered enabled; this disables it, so with no script it still works.
export const PREVIEW_SCRIPT = `(() => {
  const ta = document.getElementById("markdown");
  const btn = document.querySelector('button[name="action"][value="preview"]');
  if (!ta || !btn) return;
  const shown = ta.value;
  btn.disabled = true;
  ta.addEventListener("input", () => { btn.disabled = ta.value === shown; });
})();`;

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

// Light mode whatever the admin's theme: this is what the submitter will see.
// Hex, not oklch, on purpose - email clients do not support oklch.
// #1f1f1f on #ffffff is 16.48:1, #0b57d0 on #ffffff is 6.39:1.
const MAIL = {
  wrap: "background:#ffffff;color:#1f1f1f;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;padding:24px;max-width:600px",
  styles: {
    p: "margin:0 0 1em", h1: "font-size:24px;line-height:1.25;margin:0 0 .6em",
    h2: "font-size:20px;line-height:1.25;margin:1.2em 0 .5em", h3: "font-size:17px;margin:1.2em 0 .4em",
    ul: "margin:0 0 1em;padding-left:1.4em", li: "margin:.2em 0", a: "color:#0b57d0",
  },
};

/** The email body as HTML (a styled <div>), shared by the email and the preview. */
export const mailBody = (md) => `<div style="${MAIL.wrap}">${renderMarkdown(md, MAIL.styles)}</div>`;
const mailDocument = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>` +
  `<body style="margin:0;background:#ffffff">${body}</body></html>`;

export function approvalWorkflow({ id, label, description = "", forms, emailField = "email", templates,
                                   senderVar = "ADMIN_SENDER", replyToVar = "", ccVar = "",
                                   badge = APPROVAL_BADGE, badgeRank = 0 }) {
  for (const k of ["approve", "deny"]) {
    if (typeof templates?.[k]?.subject !== "string" || typeof templates?.[k]?.body !== "string") {
      throw new Error(`approvalWorkflow "${id}": templates.${k} needs a subject and a body string`);
    }
  }

  return {
    id, label, description, forms, badge, badgeRank,
    async run({ method, fields, record, env, request, c, action, details, now }) {
      const values = {
        ...Object.fromEntries(Object.entries(record.answers ?? {}).map(([k, v]) => [k, String(v ?? "")])),
        site_name: c.site.name, site_url: c.site.url, submitted_date: c.fmtDate(record.timestamp),
      };
      const to = String(record.answers?.[emailField] ?? "");
      const ccAddress = ccVar && EMAIL.test(String(env[ccVar] ?? "").trim()) ? String(env[ccVar]).trim() : "";

      if (method === "GET") {
        return { body: c.t.approvalStart(c, { action, details, started: now.toISOString() }) };
      }

      const decision = fields.get("decision");
      if (!Object.hasOwn(OUTCOMES, decision)) return { back: true };
      const startedRaw = String(fields.get("started") ?? "");
      const started = Number.isNaN(Date.parse(startedRaw)) ? now : new Date(startedRaw);
      const t = templates[decision];
      const subject = fill(t.subject, values, String);

      // The box starts ticked; after that it is whatever was sent back.
      const firstShow = fields.get("step") !== "respond";
      const ccOn = Boolean(ccAddress) && (firstShow || fields.get("cc") === "1");
      const respond = (markdown, error = "") => ({
        status: error ? 502 : 200,
        scripts: [PREVIEW_SCRIPT],
        body: c.t.approvalRespond(c, {
          action, decision, started: started.toISOString(), to, subject, markdown, error,
          cc: ccAddress ? { address: ccAddress, checked: ccOn } : null,
          preview: mailBody(markdown),
        }),
      });

      if (firstShow) return respond(fill(t.body, values, escapeMd));

      const choice = fields.get("action");
      if (choice === "back") return { body: c.t.approvalStart(c, { action, details, started: started.toISOString() }) };
      const markdown = String(fields.get("markdown") ?? "").slice(0, 20000);
      if (choice === "preview") return respond(markdown);
      const how = choice === "send" ? "send" : "skip";
      const event = (status, statusMessage, extra = {}) => ({
        event: `${id}-${decision}`,
        timestamp: started.toISOString(),
        duration: Math.max(0, Math.ceil(now.getTime() - started.getTime())),
        status, statusMessage, ...extra,
      });

      if (how === "send") {
        const sent = await sendMail({
          env, request, to, subject, cc: ccOn ? ccAddress : "",
          from: env[senderVar], fromName: c.site.name, replyTo: replyToVar ? env[replyToVar] : "",
          text: markdown, html: mailDocument(mailBody(markdown)), category: id,
        });
        if (!sent.ok) {
          return {
            event: event(...FAILED, { details: `send failed: ${sent.reason}` }),
            ...respond(markdown, `The email was not sent (${sent.reason}). That has been logged; try again, or don't send.`),
          };
        }
      }
      return { event: event(...OUTCOMES[decision][how], how === "send" && ccOn ? { details: `cc: ${ccAddress}` } : {}) };
    },
  };
}

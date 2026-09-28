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
 *   })
 *
 * Templates are Markdown (see markdown.js). "{{field}}" is filled from the
 * submission's answers, plus {{site_name}}, {{site_url}} and {{submitted_date}},
 * BEFORE the text is shown; the admin can still edit it.
 *
 * Pages, each "WORKFLOW: <label>":
 *   GET          the submission, [Approve] [Deny]            (the start time is set here)
 *   POST decide  the response: Markdown, a light-mode preview,
 *                [Send] [Don't send] [Update preview] [Back]
 *   POST respond send    -> email, then the event   201 "✅ with mail" / 400 "❌ with mail"
 *                skip    -> the event, no email     202 "✅ silent"    / 422 "❌ silent"
 *                preview -> page 2 again, previewing the text as typed; nothing recorded
 *                back    -> page 1 again (same start time); nothing recorded
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
                                   senderVar = "ADMIN_SENDER", replyToVar = "" }) {
  for (const k of ["approve", "deny"]) {
    if (typeof templates?.[k]?.subject !== "string" || typeof templates?.[k]?.body !== "string") {
      throw new Error(`approvalWorkflow "${id}": templates.${k} needs a subject and a body string`);
    }
  }

  return {
    id, label, description, forms,
    async run({ method, fields, record, env, request, c, action, details, now }) {
      const values = {
        ...Object.fromEntries(Object.entries(record.answers ?? {}).map(([k, v]) => [k, String(v ?? "")])),
        site_name: c.site.name, site_url: c.site.url, submitted_date: c.fmtDate(record.timestamp),
      };
      const to = String(record.answers?.[emailField] ?? "");

      if (method === "GET") {
        return { body: c.t.approvalStart(c, { action, details, started: now.toISOString() }) };
      }

      const decision = fields.get("decision");
      if (!Object.hasOwn(OUTCOMES, decision)) return { back: true };
      const startedRaw = String(fields.get("started") ?? "");
      const started = Number.isNaN(Date.parse(startedRaw)) ? now : new Date(startedRaw);
      const t = templates[decision];
      const subject = fill(t.subject, values, String);

      const respond = (markdown, error = "") => ({
        status: error ? 502 : 200,
        body: c.t.approvalRespond(c, {
          action, decision, started: started.toISOString(), to, subject, markdown, error,
          preview: mailBody(markdown),
        }),
      });

      if (fields.get("step") !== "respond") return respond(fill(t.body, values, escapeMd));

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
          env, request, to, subject,
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
      return { event: event(...OUTCOMES[decision][how]) };
    },
  };
}

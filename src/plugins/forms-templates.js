/**
 * formsPlugin's templates, merged into the one template set: override any of
 * them by name through config.templates, like a core template. ctx.base is the
 * plugin's own URL (root + its path, "/admin/forms" by default); a view is at
 * <base>/views/<id>.
 */

import { html, raw } from "../html.js";
import { cell, clip, workflowEvent, eventText, rowBadge } from "../views.js";

const EYE = raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/>
  <circle cx="12" cy="12" r="3"/></svg>`);

/** The css class of a view column: n (narrow, clipped), fill, or w (wide screens only). */
const colClass = (col) => (col.narrow === "fill" ? "fill" : col.narrow ? "n" : "w");

/** A workflow's cell: its latest statusMessage linked to it, else a button to start it. */
function workflowCell(ctx, { form, record, workflow: w }) {
  const at = `${ctx.base}/${form.id}/${record.id}`;
  const e = workflowEvent(record, w.id);
  if (e) return html`<a href="${at}#wf-${w.id}">${eventText(e)}</a>`;
  return workflowButton(ctx, { form, record, workflow: w });
}

/** A value as one line of text: objects as JSON, undefined as "". */
const flat = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));

/**
 * The mark on a cell whose ACTIVE value is not the submission's: an edit. The
 * submitted value is in the title (and for screen readers, in the text).
 */
function editedMark(col, record, text) {
  if (!record.submission || col.workflow) return "";
  const was = cell(col, record.submission);
  if (was === text) return "";
  const note = `Edited. Submitted: ${was || "(empty)"}`;
  return html` <span class="edited" title="${note}"><span aria-hidden="true">✏️</span><span class="sr">${note}</span></span>`;
}

/** The button that starts a workflow; disabled while it has no run(). */
function workflowButton(ctx, { form, record, workflow: w }) {
  return html`<form class="inline" method="get" action="${ctx.base}/${form.id}/${record.id}/run/${w.id}"><button class="run" type="submit"${
    w.implemented ? "" : raw(" disabled")}>${w.label}</button></form>`;
}

export const FORMS_TEMPLATES = {
  /** The dashboard tile. data: {forms: [{form, stats}]} */
  formsCard: (ctx, { forms }) => html`<div class="tile">
    <h3><a href="${ctx.base}">Forms</a></h3>
    <p class="big">${forms.reduce((n, f) => n + f.stats.total, 0)}</p>
    <p class="meta">submissions across ${forms.length} form${forms.length === 1 ? "" : "s"}</p>
  </div>`,

  /**
   * One of config.views: one compact row per submission, the full page width.
   * Narrow screens keep the date, the `narrow` columns and an eye button, which
   * opens the whole row (a popover: no script, the CSP allows none of ours),
   * with the row's workflow badge beside it (views.js rowBadge).
   * data: {view, form, workflows, records, next}
   */
  dashboardView: (ctx, { view, form, workflows, records, next }) => {
    const at = (r) => `${ctx.base}/${form.id}/${r.id}`;
    const wf = (col) => workflows.find((w) => w.id === col.workflow);
    const badges = workflows.some((w) => w.badge);
    const badge = (r) => {
      if (!badges) return "";
      const b = rowBadge(r, workflows);
      // An empty slot when there is none, so the eyes stay in one column.
      return b ? html`<span class="badge" role="img" aria-label="${b.title}" title="${b.title}"><small>${b.emoji}</small></span>` : html`<span class="badge"></span>`;
    };
    const td = (col, r) => {
      if (col.workflow) return html`<td class="w">${workflowCell(ctx, { form, record: r, workflow: wf(col) })}</td>`;
      const text = cell(col, r);
      const mark = editedMark(col, r, text);
      if (Number.isInteger(col.narrow) && text.length > col.narrow) {
        return html`<td class="n"><span class="n-full">${text}</span><span class="n-short">${clip(text, col.narrow)}</span>${mark}</td>`;
      }
      return html`<td class="${colClass(col)}">${text}${mark}</td>`;
    };
    return html`
    <p><a href="${ctx.base}">&larr; Forms</a></p>
    <h1>${view.label}</h1>
    <p class="meta">${form.label} made on <code>${ctx.host}</code>, newest first${view.outcome === "all" ? "" : html`,
      ${view.outcome} only`}. <a href="${ctx.base}/${form.id}">Every entry</a></p>
    ${records.length === 0 ? html`<p class="meta">Nothing to show.</p>` : html`
    <div class="scroll"><table class="compact">
      <thead><tr><th scope="col"><span class="d-full">Submitted</span><span class="d-short">Date</span></th>${view.columns.map((col) => html`<th scope="col" class="${colClass(col)}">${col.label}</th>`)}<th scope="col" class="eye"><span class="sr">View</span></th></tr></thead>
      <tbody>${records.map((r) => html`<tr>
        <td><a href="${at(r)}"><span class="d-full">${ctx.fmtDateTime(r.timestamp)}</span><span class="d-short">${ctx.fmtDate(r.timestamp)}</span></a></td>
        ${view.columns.map((col) => td(col, r))}
        <td class="eye">${badge(r)}<button type="button" class="eye-btn" popovertarget="rec-${r.id}" aria-label="View the submission of ${ctx.fmtDateTime(r.timestamp)}">${EYE}</button></td>
      </tr>`)}</tbody>
    </table></div>
    ${records.map((r) => html`<div id="rec-${r.id}" class="viewer" popover>
      <h2>${form.label}</h2>
      ${ctx.t.recordDetails(ctx, { form, view, record: r, workflows })}
      <div class="actions">
        <a href="${at(r)}">Open the submission</a>
        <button type="button" class="secondary" popovertarget="rec-${r.id}" popovertargetaction="hide">Close</button>
      </div>
    </div>`)}`}
    ${next ? html`<p><a href="${ctx.base}/views/${view.id}?cursor=${next}">Older &rarr;</a></p>` : ""}`;
  },

  /**
   * One submission as a two-column table: what its form's view shows (full
   * width, workflows included when `workflows` is given), else its raw answers.
   * data: {form, view, record, workflows}
   */
  recordDetails: (ctx, { form, view, record, workflows = null }) => {
    const rows = view
      ? view.columns.filter((col) => !col.workflow || workflows).map((col) => [col.label, col.workflow
        ? workflowCell(ctx, { form, record, workflow: workflows.find((w) => w.id === col.workflow) })
        : html`${cell(col, record)}${editedMark(col, record, cell(col, record))}`])
      : Object.keys(record.answers ?? {}).map((k) => {
        const col = { answer: k };
        return [k, html`${cell(col, record)}${editedMark(col, record, cell(col, record))}`];
      });
    return html`<div class="scroll"><table><tbody>
      <tr><th scope="row">Submitted</th><td>${ctx.fmtDateTime(record.timestamp)}</td></tr>
      ${rows.map(([k, v]) => html`<tr><th scope="row">${k}</th><td class="wrap-text">${v}</td></tr>`)}
    </tbody></table></div>`;
  },

  /** Every workflow page. data: {workflow, back, body, text} */
  workflowPage: (ctx, { workflow, back, body = "", text = "" }) => html`
    <p><a href="${back}">&larr; Back</a></p>
    <h1>WORKFLOW: ${workflow.label}</h1>
    ${text ? html`<p>${text}</p>` : ""}
    ${body}`,

  /** approvalWorkflow, page 1. data: {action, details, started} */
  approvalStart: (ctx, { action, details, started }) => html`
    <h2>The submission</h2>
    ${details}
    <form method="post" action="${action}">
      <input type="hidden" name="step" value="decide">
      <input type="hidden" name="started" value="${started}">
      <div class="actions">
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
      </div>
    </form>`,

  /** approvalWorkflow, page 2. data: {action, decision, started, to, subject, markdown, preview, cc: null | {address, checked}, error} */
  approvalRespond: (ctx, { action, decision, started, to, subject, markdown, preview, cc = null, error = "" }) => html`
    <h2>Send response to submitter</h2>
    ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
    <dl class="pairs">
      <dt>Decision</dt><dd>${decision === "approve" ? "Approve" : "Deny"}</dd>
      <dt>To</dt><dd>${to || "(no email address)"}</dd>
      <dt>Subject</dt><dd>${subject}</dd>
    </dl>
    <form method="post" action="${action}">
      <input type="hidden" name="step" value="respond">
      <input type="hidden" name="decision" value="${decision}">
      <input type="hidden" name="started" value="${started}">
      <label for="markdown">Message (you can customise this markdown)</label>
      <textarea id="markdown" name="markdown" rows="14">${markdown}</textarea>
      <h3>Preview</h3>
      <p class="meta">The email in light mode. "Update preview" shows your edits; Send sends the text as typed.</p>
      <div class="mail-preview">${raw(preview)}</div>
      ${cc ? html`<p><label><input type="checkbox" name="cc" value="1"${cc.checked ? raw(" checked") : ""}> cc: ${cc.address}</label></p>` : ""}
      <div class="actions">
        <button type="submit" name="action" value="send">Send</button>
        <button type="submit" name="action" value="skip" class="secondary">Don't send</button>
        <button type="submit" name="action" value="preview" class="secondary">Update preview</button>
        <button type="submit" name="action" value="back" class="secondary">Back</button>
      </div>
    </form>`,

  /**
   * One card per form: its name (to its view if it has one, else its entries),
   * how many were sent of how many submitted, and the newest.
   * data: {forms: [{form, stats}], origin, views}
   */
  formsIndex: (ctx, { forms, origin, views = [] }) => html`
    <h1>Forms</h1>
    <p class="meta">${ctx.copy.formsIntro} <code>${new URL(origin).host}</code></p>
    <div class="tiles">${forms.map(({ form, stats }) => {
      const view = views.find((v) => v.form === form.id);
      return html`
      <div class="tile">
        <h3><a href="${view ? `${ctx.base}/views/${view.id}` : `${ctx.base}/${form.id}`}">${form.label}</a></h3>
        <p class="count">${stats.outcomes.sent?.count ?? 0} sent of ${stats.total} submitted</p>
        <p><em>newest</em>: ${stats.latest ? ctx.fmtDateTime(stats.latest.timestamp) : "none yet"}</p>
      </div>`;
    })}
    </div>`,

  /** data: {form, stats, records, outcome, next} */
  formsList: (ctx, { form, stats, records, outcome, next }) => {
    const filters = ["all", ...Object.keys(stats.outcomes).sort()];
    const fieldNames = (records[0]?.formMeta?.fields ?? []).slice(0, 3).map((f) => f.name);
    return html`
    <p><a href="${ctx.base}">&larr; Forms</a></p>
    <h1>${form.label}</h1>
    <p class="meta">${stats.total} entries made on <code>${ctx.host}</code>. Answers are kept only for sent and send-failed submissions.</p>
    <nav class="filters" aria-label="Filter by outcome">${filters.map((o) => html`
      <a href="${ctx.base}/${form.id}?outcome=${o}"${o === outcome ? raw(' aria-current="page"') : ""}>${o}${
        o === "all" ? "" : html` (${stats.outcomes[o].count})`}</a>`)}
    </nav>
    ${records.length === 0 ? html`<p class="meta">Nothing to show.</p>` : html`
    <div class="scroll"><table>
      <thead><tr><th scope="col">Received</th><th scope="col">Outcome</th>${fieldNames.map((n) => html`<th scope="col">${n}</th>`)}</tr></thead>
      <tbody>${records.map((r) => html`<tr>
        <td><a href="${ctx.base}/${form.id}/${r.id}">${ctx.fmtTime(r.timestamp)}</a></td>
        <td>${r.outcome}</td>
        ${fieldNames.map((n) => html`<td>${String(r.answers?.[n] ?? "").slice(0, 80)}</td>`)}
      </tr>`)}</tbody>
    </table></div>`}
    ${next ? html`<p><a href="${ctx.base}/${form.id}?outcome=${outcome}&amp;cursor=${next}">Older &rarr;</a></p>` : ""}`;
  },

  /** data: {form, record, workflows} */
  formsRecord: (ctx, { form, record, workflows }) => {
    const known = (record.formMeta?.fields ?? []).map((f) => f.name);
    const sub = record.submission ?? record;
    const keys = [...new Set([...known, ...Object.keys(record.answers ?? {}), ...Object.keys(sub.answers ?? {})])]
      .filter((k) => Object.hasOwn(record.answers ?? {}, k) || Object.hasOwn(sub.answers ?? {}, k));
    const edited = record.edited ?? [];
    const answerEdited = (k) => edited.some((p) => p === "answers" || p === `answers.${k}` || p.startsWith(`answers.${k}.`));
    const strip = ({ submission, edited: _, ...r }) => r;
    return html`
    <p><a href="${ctx.base}/${form.id}">&larr; ${form.label}</a></p>
    <h1>${ctx.fmtTime(record.timestamp)}</h1>
    <p class="meta">Outcome <strong>${record.outcome}</strong> · form version ${record.formMeta?.version || "?"} ·
      engine ${record.formMeta?.engine || "?"} · <code>${record.id}</code></p>
    ${edited.length ? html`<p class="notice" role="note"><strong>Edited.</strong> This is the ACTIVE record: the submission
      with ${edited.length} change${edited.length === 1 ? "" : "s"} applied (${edited.join(", ")}). The submission itself is
      never changed; each edited answer shows it underneath, and History says who changed what and why.</p>` : ""}

    <h2>Answers</h2>
    ${keys.length === 0
      ? html`<p class="meta">None kept - answers are stored only for sent and send-failed submissions.</p>`
      : html`<div class="scroll"><table><tbody>${keys.map((k) => html`
        <tr><th scope="row">${k}${answerEdited(k) ? html` <span class="edited" title="Edited">✏️</span>` : ""}</th><td class="wrap-text">${flat(record.answers?.[k])}${
          answerEdited(k) ? html`<span class="was">Submitted: ${Object.hasOwn(sub.answers ?? {}, k) ? flat(sub.answers[k]) : "(not present)"}</span>` : ""}</td></tr>`)}</tbody></table></div>`}
    ${record.submission ? html`<details class="json">
      <summary>The whole record as JSON: active${edited.length ? " and submission" : ""}</summary>
      <h3>Active</h3><pre>${JSON.stringify(strip(record), null, 2)}</pre>
      ${edited.length ? html`<h3>Submission</h3><pre>${JSON.stringify(record.submission, null, 2)}</pre>` : ""}
    </details>` : ""}

    <h2>Workflows</h2>
    <div class="wf-list">${workflows.length === 0 ? html`<p class="meta">None for this form.</p>` : workflows.map((w) => html`
      <p id="wf-${w.id}"><strong>${w.label}</strong>${w.description ? html` - ${w.description}` : ""}
        ${workflowEvent(record, w.id) ? html`<br>Latest: ${eventText(workflowEvent(record, w.id))}` : ""}
        <br>${workflowButton(ctx, { form, record, workflow: w })}${w.implemented ? "" : html` <span class="meta">(not implemented yet)</span>`}</p>`)}
    </div>

    <h2>History</h2>
    <div class="scroll"><table>
      <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Message</th><th scope="col">Took</th><th scope="col">By</th></tr></thead>
      <tbody>${(record.workflow?.events ?? []).map((e) => html`<tr>
        <td>${ctx.fmtDateTime(e.timestamp)}</td><td>${e.event}</td><td>${e.status}</td><td>${e.statusMessage}${e.details ? html`<br><span class="meta">${e.details}</span>` : ""}${
          e.changes?.length ? html`<ul class="changes">${e.changes.map((ch) => html`<li><code>${ch.path}</code>: ${
            ch.from === undefined ? html`<em>(none)</em>` : flat(ch.from)} &rarr; ${ch.to === undefined ? html`<em>(removed)</em>` : flat(ch.to)}</li>`)}</ul>` : ""}</td>
        <td>${Number.isInteger(e.duration) ? `${(e.duration / 1000).toFixed(1)} s` : ""}</td><td>${e.actor ?? ""}</td></tr>`)}</tbody>
    </table></div>

    <h2>Session</h2>
    <div class="scroll"><table><tbody>${Object.entries(record.session ?? {}).map(([k, v]) => html`
      <tr><th scope="row">${k}</th><td class="wrap-text">${flat(v)}</td></tr>`)}</tbody></table></div>
    <p class="meta">Posted to <code>${record.url}</code></p>`;
  },
};

/**
 * formsPlugin(options) -> an admin plugin: a read-only browser over a
 * cf-form-mailer submission log, views over it, and workflows on a submission.
 *
 *   formsPlugin({
 *     toRecord,                      // required: cf-form-mailer's row -> record
 *     list: [{ id, label, path, service }],
 *     workflows: [...],              // see ../workflows.js; approvalWorkflow() makes one
 *     views: [...],                  // see ../views.js
 *     path: "/forms",                // where it is mounted under the admin root
 *   })
 *
 * Its pages, under <root><path> (default /admin/forms):
 *   GET  /                           per form: totals and the newest submission
 *   GET  /views/<id>                 one of `views`: a compact table over one form, ?cursor=
 *   GET  /<form>                     browse, newest first, ?outcome= ?cursor=
 *   GET  /<form>/<uid>               one submission, its workflows and history
 *   GET/POST /<form>/<uid>/run/<wf>  a workflow's pages; its ONE event is appended
 *                                    to the workflow log (ADMIN_DB workflow_events)
 *
 * READ ONLY on FORM_DB (modules/forms.js select()), and every query is limited
 * to the origin the admin is being viewed on: a staging admin never shows
 * production data.
 */

import { formStats, listSubmissions, getSubmission } from "../modules/forms.js";
import { withEvents, appendEvent, checkEvent } from "../modules/events.js";
import { dbPing, formHealth } from "../modules/health.js";
import { normaliseWorkflows, workflowsFor } from "../workflows.js";
import { normaliseViews } from "../views.js";
import { FORMS_TEMPLATES } from "./forms-templates.js";

const RECORD = /^\/([a-z0-9-]+)(?:\/([0-9a-f-]{36}))?$/;
const RUN = /^\/([a-z0-9-]+)\/([0-9a-f-]{36})\/run\/([a-z0-9-]+)$/;
const VIEW = /^\/views\/([a-z0-9-]+)$/;

export function formsPlugin({ toRecord, list = [], workflows = [], views = [], path = "/forms", label = "Forms" } = {}) {
  if (typeof toRecord !== "function") {
    throw new Error("formsPlugin: toRecord is required - pass cf-form-mailer's toRecord");
  }
  for (const f of list) {
    if (!/^[a-z0-9-]+$/.test(f.id ?? "") || !f.label || !f.path) {
      throw new Error("formsPlugin: each list entry needs id, label and path");
    }
    if (f.id === "views") throw new Error('formsPlugin: "views" cannot be a form id - it is where the views live');
  }
  const forms = list;
  const wfs = normaliseWorkflows(workflows);
  const vs = normaliseViews(views, { forms, workflows: wfs });

  const allStats = (env, origin) => Promise.all(forms.map(async (form) => ({
    form, stats: await formStats(env.FORM_DB, form.id, origin),
  })));

  // A listing with a bad ?cursor= or ?outcome= is a 404, not an error.
  const listing = (env, args) => listSubmissions(env.FORM_DB, { ...args, toRecord })
    .catch((err) => { if (err instanceof RangeError) return null; throw err; });

  const unavailable = (admin) => admin.page("Unavailable", admin.t.message(admin.c, {
    heading: "Unavailable", text: "The submission log could not be read. Check the Health table on the dashboard.",
  }), { status: 503 });

  async function runWorkflow(request, env, admin, [, formId, uid, wfId]) {
    const { c, t, user, url } = admin;
    const form = forms.find((f) => f.id === formId);
    const wf = form && workflowsFor(wfs, form.id).find((w) => w.id === wfId);
    if (!wf) return admin.notFound();
    const view = vs.find((v) => v.form === form.id);
    const back = view ? `${admin.base}/views/${view.id}` : `${admin.base}/${form.id}/${uid}`;
    const wfPage = (data, status = 200) =>
      admin.page(`Workflow: ${wf.label}`, t.workflowPage(c, { workflow: wf, back, ...data }), { status });
    if (!wf.implemented) return wfPage({ text: "This workflow is not implemented yet." }, 409);
    const GET = request.method === "GET" || request.method === "HEAD";
    try {
      const record = await getSubmission(env.FORM_DB, { formId: form.id, origin: url.origin, uid, toRecord });
      if (!record) return admin.notFound();
      await withEvents(env.ADMIN_DB, { origin: url.origin, form: form.id, records: [record] });
      const r = await wf.run({
        method: GET ? "GET" : "POST",
        fields: GET ? new URLSearchParams() : await request.formData(),
        record, env, request, user, c, now: new Date(),
        action: `${admin.base}${admin.path}`,
        details: t.recordDetails(c, { form, view, record }),
      });
      if (r?.event) {
        const bad = checkEvent(wf.id, r.event);
        if (bad) throw new Error(`bad event: ${bad}`);
        // Anything the workflow sent has gone: if this append fails, the log
        // below is the only trace, so it names what was lost.
        await appendEvent(env.ADMIN_DB, { origin: url.origin, form: form.id, uid: record.id, actor: user.email, event: r.event })
          .catch((err) => { throw new Error(`event NOT logged ${JSON.stringify(r.event)} for ${record.id}: ${err.message}`); });
        console.log(`[admin] ${user.email} ${r.event.event} ${r.event.status} on ${form.id}/${record.id}`);
        if (r.body) return wfPage({ body: r.body }, r.status ?? 200);
        return admin.redirect(back);
      }
      if (r?.back) return admin.redirect(back);
      if (r?.body) return wfPage({ body: r.body }, r.status ?? 200);
      throw new Error("run() returned no body, back or event");
    } catch (err) {
      console.log(`[admin] workflow ${wf.id} failed: ${err.stack || err.message}`);
      return wfPage({ text: "The workflow failed and nothing was recorded. The Worker log has the detail." }, 502);
    }
  }

  return {
    id: "forms",
    path,
    label,
    templates: FORMS_TEMPLATES,

    async fetch(request, env, ctx, admin) {
      const run = admin.path.match(RUN);
      if (run) return runWorkflow(request, env, admin, run);
      if (request.method !== "GET" && request.method !== "HEAD") return null;
      const { c, t, url } = admin;
      try {
        const v = admin.path.match(VIEW);
        if (v) {
          const view = vs.find((x) => x.id === v[1]);
          if (!view) return null;
          const page = await listing(env, { formId: view.form, origin: url.origin, outcome: view.outcome, cursor: url.searchParams.get("cursor") });
          if (!page) return null;
          const form = forms.find((f) => f.id === view.form);
          await withEvents(env.ADMIN_DB, { origin: url.origin, form: form.id, records: page.records });
          return admin.page(view.label, t.dashboardView(c, { view, form, workflows: workflowsFor(wfs, form.id), ...page }), { wide: true });
        }
        if (admin.path === "/") {
          return admin.page("Forms", t.formsIndex(c, { forms: await allStats(env, url.origin), origin: url.origin, views: vs }));
        }
        const m = admin.path.match(RECORD);
        const form = m && forms.find((f) => f.id === m[1]);
        if (!form) return null;
        if (!m[2]) {
          const outcome = url.searchParams.get("outcome") || "all";
          const page = await listing(env, { formId: form.id, origin: url.origin, outcome, cursor: url.searchParams.get("cursor") });
          if (!page) return null;
          const stats = await formStats(env.FORM_DB, form.id, url.origin);
          return admin.page(form.label, t.formsList(c, { form, stats, outcome, ...page }));
        }
        const record = await getSubmission(env.FORM_DB, { formId: form.id, origin: url.origin, uid: m[2], toRecord });
        if (!record) return null;
        await withEvents(env.ADMIN_DB, { origin: url.origin, form: form.id, records: [record] });
        return admin.page(form.label, t.formsRecord(c, { form, record, workflows: workflowsFor(wfs, form.id) }));
      } catch (err) {
        console.log(`[admin] ${admin.base}${admin.path} failed: ${err.stack || err.message}`);
        return unavailable(admin);
      }
    },

    async dashboard(env, admin) {
      const stats = env.FORM_DB ? await allStats(env, admin.url.origin).catch(() => []) : [];
      return admin.t.formsCard(admin.c, { forms: stats });
    },

    async health(env, admin) {
      return [
        { name: "Forms database (FORM_DB)", ...await dbPing(env.FORM_DB, "SELECT 1 FROM submissions LIMIT 1") },
        ...await Promise.all(forms.map(async (f) => ({ name: `Form: ${f.label}`, ...await formHealth(env, f, admin.url.origin) }))),
      ];
    },

    async flags(env) {
      return { formDb: (await dbPing(env.FORM_DB, "SELECT 1 FROM submissions LIMIT 1")).ok };
    },
  };
}

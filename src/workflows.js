/**
 * Workflows: things staff can do in response to a submission. A consumer lists
 * them in formsPlugin({ workflows }) (approvalWorkflow() in approval.js makes one):
 *
 *   { id: "wf02", label: "Parking approval", description: "...", forms: ["parking"],
 *     run: async (args) => result }
 *
 * `forms` limits which forms offer it (omit for every form). A workflow with no
 * `run` is a placeholder: its button is shown, disabled.
 *
 * BADGES, optional: `badge` maps the status of the workflow's latest event to one
 * emoji, shown by a view's eye button on narrow screens, e.g.
 *   badge: { 201: "✅", 202: "✅", 400: "❌", 422: "❌" }, badgeRank: 1
 * Of the workflows whose latest event has a badge, the highest `badgeRank`
 * (default 0) wins. Whatever the ranks, a row whose most recent event of ALL is a
 * 5xx shows ERROR_BADGE (views.js).
 *
 * THE RULE: a workflow changes nothing. The only thing it can produce is ONE
 * event, which the tool checks (modules/events.js checkEvent) and appends to the
 * append-only workflow log; readers take the latest event per workflow. Sending
 * an email is allowed - it is what a workflow is for - but it must happen before
 * the event that says it did.
 *
 * An event may carry a `patch` (src/patch.js): it still changes nothing in
 * FORM_DB, but every reader then sees the ACTIVE record - the submission with
 * the patches applied. `record` below is the active record; `record.submission`
 * is what arrived, frozen.
 *
 * run() is called for GET and POST <base>/<form>/<uid>/run/<id>, every page
 * headed "WORKFLOW: <label>" by the tool. args:
 *   method   "GET" (the start page) or "POST" (any later step)
 *   fields   the POSTed form (URLSearchParams-like .get); empty on GET
 *   record   the submission, its logged events included
 *   action   the URL every step's <form> posts back to
 *   details  html: the submission as the form's view shows it (or its answers)
 *   c        the template context: c.t (templates), c.site, c.fmtDate...
 *   env, request, user, now (a Date)
 * It returns ONE of:
 *   { body, status?, scripts? }  another page (html``); nothing is recorded.
 *                      `scripts`: JavaScript sources inlined after the body and
 *                      allowed by their sha256 in that page's CSP only (csp.js)
 *   { back: true }     cancel: back to the view; nothing is recorded
 *   { event }          done: the event is checked and appended, then back
 *   { event, body }    the event is appended, then this page is shown - e.g. a
 *                      failure logged, with the form kept for another try
 */

const ID = /^[a-z0-9-]{1,40}$/;

function checkBadge(w) {
  if (w.badge === undefined) return null;
  const entries = Object.entries(w.badge ?? {});
  if (w.badge === null || typeof w.badge !== "object" || Array.isArray(w.badge) || !entries.length
      || entries.some(([k, v]) => !/^[1-5]\d\d$/.test(k) || typeof v !== "string" || !v.trim() || v.length > 16)) {
    throw new Error(`workflow "${w.id}": badge must map HTTP status codes to a short string, e.g. { 201: "✅" }`);
  }
  if (w.badgeRank !== undefined && !Number.isFinite(w.badgeRank)) throw new Error(`workflow "${w.id}": badgeRank must be a number`);
  return Object.fromEntries(entries.map(([k, v]) => [Number(k), v.trim()]));
}

export function normaliseWorkflows(list = []) {
  const seen = new Set();
  return list.map((w) => {
    if (!ID.test(w?.id ?? "")) throw new Error(`workflow id "${w?.id}" must match ${ID}`);
    if (seen.has(w.id)) throw new Error(`workflow id "${w.id}" is used twice`);
    seen.add(w.id);
    return {
      id: w.id,
      label: w.label || w.id,
      description: w.description || "",
      forms: Array.isArray(w.forms) ? w.forms : null,
      implemented: typeof w.run === "function",
      badge: checkBadge(w),
      badgeRank: w.badgeRank ?? 0,
      run: w.run,
    };
  });
}

export const workflowsFor = (workflows, formId) =>
  workflows.filter((w) => !w.forms || w.forms.includes(formId));

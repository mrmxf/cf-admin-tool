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
 * THE RULE: a workflow changes nothing. The only thing it can produce is ONE
 * event, which the tool checks (modules/events.js checkEvent) and appends to the
 * append-only workflow log; readers take the latest event per workflow. Sending
 * an email is allowed - it is what a workflow is for - but it must happen before
 * the event that says it did.
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
 *   { body, status? }  another page (html``); nothing is recorded
 *   { back: true }     cancel: back to the view; nothing is recorded
 *   { event }          done: the event is checked and appended, then back
 *   { event, body }    the event is appended, then this page is shown - e.g. a
 *                      failure logged, with the form kept for another try
 */

const ID = /^[a-z0-9-]{1,40}$/;

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
      run: w.run,
    };
  });
}

export const workflowsFor = (workflows, formId) =>
  workflows.filter((w) => !w.forms || w.forms.includes(formId));

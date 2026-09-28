/**
 * Views: compact tables, each over ONE form's submissions, served by formsPlugin
 * at <base>/views/<id> and linked from the Forms page. A consumer lists them in
 * formsPlugin({ views }):
 *
 *   { id: "parking", label: "Parking", form: "parking", outcome: "sent",
 *     columns: [
 *       { label: "Email", answer: "email" },
 *       { label: "Car", value: (r) => `${r.answers.car_make} (${r.answers.car_model})` },
 *       { label: "Approval", workflow: "wf02" },
 *     ] }
 *
 * `form` is an id from formsPlugin's list. `outcome` picks the rows (default
 * "sent": the only rows whose answers are worth a table; "all" for every row).
 * The linked "Submitted" column is always first, so it is not listed.
 *
 * A column is ONE of:
 *   answer    a field name: that answer, as typed
 *   value     (record) => string, for anything built from several answers
 *   workflow  a workflow id: once it has run, its latest statusMessage linked to
 *             the submission; before, a button to run it (disabled until the
 *             workflow has a run()) - see workflowEvent below
 * An empty cell is blank.
 *
 * NARROW SCREENS show the date (no time), the columns marked `narrow`, and an
 * eye button that opens the whole row. `narrow: 30` shows the first 30
 * characters and an ellipsis; `narrow: "fill"` (one per view) takes the rest of
 * the width. Unmarked columns are wide-screen only.
 */

import { isEventOf } from "./modules/events.js";

const ID = /^[a-z0-9-]{1,40}$/;
const CAP = 80;

export function normaliseViews(list = [], { forms, workflows }) {
  const seen = new Set();
  return list.map((v) => {
    const where = `view "${v?.id}"`;
    if (!ID.test(v?.id ?? "")) throw new Error(`${where}: id must match ${ID}`);
    if (seen.has(v.id)) throw new Error(`${where}: id is used twice`);
    seen.add(v.id);
    if (!forms.some((f) => f.id === v.form)) throw new Error(`${where}: form "${v.form}" is not in formsPlugin's list`);
    if (!Array.isArray(v.columns) || v.columns.length === 0) throw new Error(`${where}: needs columns`);
    for (const c of v.columns) {
      const kinds = ["answer", "value", "workflow"].filter((k) => c?.[k] !== undefined);
      if (!c?.label || kinds.length !== 1) throw new Error(`${where}: each column needs a label and one of answer, value, workflow`);
      if (c.value !== undefined && typeof c.value !== "function") throw new Error(`${where}: column "${c.label}" value must be a function`);
      if (c.narrow !== undefined && c.narrow !== "fill" && !(Number.isInteger(c.narrow) && c.narrow > 0)) {
        throw new Error(`${where}: column "${c.label}" narrow must be a number of characters or "fill"`);
      }
      if (c.workflow !== undefined && c.narrow !== undefined) throw new Error(`${where}: a workflow column cannot be narrow`);
      if (c.workflow !== undefined) {
        const w = workflows.find((x) => x.id === c.workflow);
        if (!w) throw new Error(`${where}: column "${c.label}" names workflow "${c.workflow}", which is not in formsPlugin's workflows`);
        if (w.forms && !w.forms.includes(v.form)) throw new Error(`${where}: workflow "${w.id}" is not offered on form "${v.form}"`);
      }
    }
    if (v.columns.filter((c) => c.narrow === "fill").length > 1) throw new Error(`${where}: only one column can be narrow: "fill"`);
    return { id: v.id, label: v.label || v.id, form: v.form, outcome: v.outcome || "sent", columns: v.columns };
  });
}

/**
 * The latest event a workflow appended to record.workflow.events, or null if it
 * has not run on this submission. `event` is the workflow id, or the id and a
 * decorator ("wf02-approve"); see modules/events.js for the whole event.
 */
export function workflowEvent(record, workflowId) {
  return (record.workflow?.events ?? []).filter((x) => isEventOf(x?.event, workflowId)).at(-1) ?? null;
}

/** What a view shows for a workflow's event: its statusMessage, else its status. */
export const eventText = (e) =>
  String(e?.statusMessage ?? "").trim() || String(e?.status ?? "").trim() || "done";

/** The first n characters, with an ellipsis if there were more. */
export const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One answer/value cell's text, capped, "" when empty. Workflow cells are the template's. */
export function cell(column, record) {
  let v;
  if (column.value) {
    // One odd old row must not take the whole table down.
    try { v = column.value(record); } catch { v = ""; }
  } else v = record.answers?.[column.answer];
  const s = String(v ?? "").trim();
  if (!s) return "";
  return clip(s, CAP - 1);
}

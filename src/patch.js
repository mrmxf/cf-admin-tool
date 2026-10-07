/**
 * Submission and active.
 *
 * The SUBMISSION is what arrived: a FORM_DB row through the consumer's toRecord.
 * It is immutable - nothing ever writes it. The ACTIVE record is the submission
 * with every patch in the workflow log applied, in append order. With no
 * patches, active equals the submission.
 *
 * A patch is an RFC 7396 JSON Merge Patch over the record, carried by ONE event
 * (modules/events.js). Its one limit: `null` means "remove this key", so no
 * value can be SET to null.
 *
 * FIXED fields are never patched: `id` (the uid every patch is keyed on - an
 * edited id would detach the record from its own history), `workflow` (the
 * log: an editable log is a forgeable log), and the two this module adds,
 * `submission` and `edited`.
 */

export const FIXED = Object.freeze(["id", "workflow", "submission", "edited"]);
export const PATCH_MAX = 32 * 1024;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** RFC 7396: `patch` applied to `target`. Neither argument is changed. */
export function mergePatch(target, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const out = isObject(target) ? structuredClone(target) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/**
 * The merge patch that turns `from` into `to`: only what changed. Objects are
 * compared key by key, anything else (arrays included) is replaced whole.
 * {} when they are equal. A `null` in `to` cannot be expressed - see editable()
 * callers, which check mergePatch(from, diffPatch(from, to)) equals `to`.
 */
export function diffPatch(from, to) {
  const out = {};
  for (const k of Object.keys(from ?? {})) if (!Object.hasOwn(to, k)) out[k] = null;
  for (const [k, v] of Object.entries(to)) {
    const was = from?.[k];
    if (isObject(was) && isObject(v)) {
      const d = diffPatch(was, v);
      if (Object.keys(d).length) out[k] = d;
    } else if (!Object.hasOwn(from ?? {}, k) || !same(was, v)) out[k] = v;
  }
  return out;
}

/**
 * Where `a` and `b` differ, as dotted paths with both values:
 * [{ path: "answers.vehicle_reg", from: "AB12", to: "XY34" }]. A value missing
 * on one side is undefined there.
 */
export function changes(a, b, prefix = "") {
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const path = prefix ? `${prefix}.${k}` : k;
    const x = a?.[k];
    const y = b?.[k];
    if (isObject(x) && isObject(y)) out.push(...changes(x, y, path));
    else if (!same(x, y)) out.push({ path, from: x, to: y });
  }
  return out;
}

export function deepFreeze(v) {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** The part of a record a patch may change: a copy without the FIXED fields. */
export function editable(record) {
  const out = structuredClone(record);
  for (const k of FIXED) delete out[k];
  return out;
}

/** null if `patch` is a patch this tool will store, else what is wrong. */
export function checkPatch(patch) {
  if (!isObject(patch)) return "patch must be a JSON object";
  if (Object.keys(patch).length === 0) return "patch is empty";
  const fixed = Object.keys(patch).filter((k) => FIXED.includes(k));
  if (fixed.length) return `patch cannot change ${fixed.join(", ")}`;
  const bad = (v) => isObject(v) && Object.entries(v).some(([k, x]) => UNSAFE.has(k) || bad(x));
  if (bad(patch)) return "patch cannot use __proto__, constructor or prototype as a key";
  if (JSON.stringify(patch).length > PATCH_MAX) return `patch must be at most ${PATCH_MAX} bytes as JSON`;
  return null;
}

/**
 * Make `record` (the submission, its events attached) its ACTIVE self, IN
 * PLACE: every patch applied, in order; `submission` = the frozen original;
 * `edited` = the changed paths; each patch event gains `changes` (path, from,
 * to) for the history. `id` and `workflow` are the submission's whatever a
 * patch said.
 */
export function activate(record, submission) {
  let active = editable(submission);
  for (const e of record.workflow?.events ?? []) {
    if (!e.patch) continue;
    const next = mergePatch(active, e.patch);
    e.changes = changes(active, next);
    active = next;
  }
  const { id, workflow } = record;
  for (const k of Object.keys(record)) delete record[k];
  Object.assign(record, active, { id, workflow, submission: deepFreeze(submission) });
  record.edited = changes(editable(submission), active).map((c) => c.path);
  return record;
}

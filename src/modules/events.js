/**
 * The workflow log (ADMIN_DB workflow_events, db/migrations/0002). APPEND-ONLY:
 * this module has an INSERT and a SELECT and nothing else, on purpose.
 *
 * THE EVENT a workflow produces - the only thing it can produce:
 *
 *   { event:         "<workflow id>" or "<workflow id>-<decorator>", e.g. "wf02-approve"
 *     timestamp:     ISO string, when the workflow was started
 *     duration:      whole milliseconds it took, rounded up
 *     status:        an HTTP status code (100-599) saying how it ended
 *     statusMessage: the short phrase the tables show, e.g. "✅ with mail"
 *     details:       OPTIONAL - why it ended as it did, e.g. why a send failed }
 *
 * checkEvent() refuses anything else; the tool adds who ran it and where.
 */

const DECORATED = (id) => new RegExp(`^${id}(-[a-z0-9-]{1,40})?$`);

/** null if the event is well formed for workflow `id`, else what is wrong. */
export function checkEvent(id, e) {
  if (!e || typeof e !== "object") return "no event";
  if (!DECORATED(id).test(String(e.event ?? ""))) return `event "${e.event}" must be "${id}" or "${id}-<decorator>"`;
  if (typeof e.timestamp !== "string" || Number.isNaN(Date.parse(e.timestamp))) return "timestamp must be an ISO date";
  if (!Number.isSafeInteger(e.duration) || e.duration < 0) return "duration must be whole milliseconds, 0 or more";
  if (!Number.isInteger(e.status) || e.status < 100 || e.status > 599) return "status must be an HTTP status code";
  if (typeof e.statusMessage !== "string" || !e.statusMessage.trim() || e.statusMessage.length > 120) {
    return "statusMessage must be 1-120 characters";
  }
  if (e.details !== undefined && (typeof e.details !== "string" || e.details.length > 1000)) {
    return "details, if given, must be a string of at most 1000 characters";
  }
  return null;
}

/** True if `event` belongs to workflow `id` ("wf02" or "wf02-approve"). */
export const isEventOf = (event, id) => event === id || String(event ?? "").startsWith(`${id}-`);

export async function appendEvent(db, { origin, form, uid, actor, event: e }) {
  await db.prepare(
    `INSERT INTO workflow_events (origin, form, uid, event, timestamp, duration, status, status_message, details, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(origin, form, uid, e.event, e.timestamp, e.duration, e.status, e.statusMessage.trim(), e.details ?? "", actor,
    Math.floor(Date.now() / 1000)).run();
}

/**
 * Add the logged events to each record's workflow.events, after its own, in
 * append order. Returns the same records. No ADMIN_DB, or no records: unchanged.
 */
export async function withEvents(db, { origin, form, records }) {
  if (!db || records.length === 0) return records;
  const uids = records.map((r) => r.id);
  const { results = [] } = await db.prepare(
    `SELECT uid, event, timestamp, duration, status, status_message AS statusMessage, details, actor
     FROM workflow_events WHERE origin = ? AND form = ? AND uid IN (${uids.map(() => "?").join(", ")})
     ORDER BY id`,
  ).bind(origin, form, ...uids).all();
  const byUid = Map.groupBy(results, (r) => r.uid);
  for (const r of records) {
    const extra = (byUid.get(r.id) ?? []).map(({ uid, ...e }) => e);
    if (extra.length) r.workflow = { ...r.workflow, events: [...(r.workflow?.events ?? []), ...extra] };
  }
  return records;
}

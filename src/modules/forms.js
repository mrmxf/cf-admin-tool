/**
 * The forms module: statistics and browsing over a cf-form-mailer submission log.
 *
 * READ-ONLY. The table belongs to cf-form-mailer (its db/migrations); this
 * module never writes to it and never migrates it. Every query goes through
 * select(), which refuses anything that is not a single SELECT.
 *
 * SAME ORIGIN. Every query is limited to rows whose `url` (the URL the form was
 * POSTed to) is on the origin the admin page is being viewed on. The log is
 * one database per site, and a staging admin must not show production answers.
 *
 * Rows leave this module only through the consumer's `toRecord` (cf-form-mailer
 * exports it), the one function that understands every schema_version. The
 * internal `id` is used for paging, wrapped in an opaque cursor, never shown.
 */

// The columns toRecord() reads, under the names it reads them by.
const COLUMNS = `id, uid, form, url, timestamp, schema_version AS schemaVersion, outcome,
       form_meta AS formMeta, answers, session, workflow`;

const SAME_ORIGIN = "url LIKE ? ESCAPE '\\'";

export const PAGE_SIZE = 50;
const OUTCOME = /^[a-z-]{1,32}$/;
const UID = /^[0-9a-f-]{36}$/;

/** A prepared, bound statement - but only for one plain SELECT. */
export function select(db, sql, ...binds) {
  if (!/^\s*SELECT\s/i.test(sql) || sql.includes(";")) {
    throw new Error("forms module: read-only, one SELECT per statement");
  }
  return db.prepare(sql).bind(...binds);
}

/** LIKE pattern matching every URL on `origin`: its own % and _ escaped. */
export function originPattern(origin) {
  return `${String(origin).replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

export const encodeCursor = (id) =>
  btoa(JSON.stringify({ id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decodeCursor(s) {
  try {
    const c = JSON.parse(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")));
    if (Number.isSafeInteger(c.id) && c.id > 0) return c.id;
  } catch { /* fall through */ }
  return null;
}

/** Counts per outcome, total, latest of each, and the latest submission overall. */
export async function formStats(db, formId, origin) {
  const like = originPattern(origin);
  const [byOutcome, latest] = await Promise.all([
    select(db, `SELECT outcome, COUNT(*) AS total, MAX(timestamp) AS latestAt
                FROM submissions WHERE form = ? AND ${SAME_ORIGIN} GROUP BY outcome`, formId, like).all(),
    select(db, `SELECT uid, timestamp, outcome FROM submissions
                WHERE form = ? AND ${SAME_ORIGIN} ORDER BY id DESC LIMIT 1`, formId, like).first(),
  ]);
  const outcomes = {};
  let total = 0;
  for (const r of byOutcome.results ?? []) {
    outcomes[r.outcome] = { count: r.total, latest: r.latestAt };
    total += r.total;
  }
  return { form: formId, total, outcomes, latest: latest ?? null };
}

/**
 * One page, newest first.
 * @returns {Promise<{records: object[], next: string|null}>}
 */
export async function listSubmissions(db, { formId, origin, outcome = "all", cursor, toRecord, limit = PAGE_SIZE }) {
  if (outcome !== "all" && !OUTCOME.test(outcome)) throw new RangeError("bad outcome");
  const before = cursor ? decodeCursor(cursor) : Number.MAX_SAFE_INTEGER;
  if (before === null) throw new RangeError("bad cursor");
  const { results = [] } = await select(db,
    `SELECT ${COLUMNS} FROM submissions
     WHERE form = ? AND ${SAME_ORIGIN} AND outcome LIKE ? AND id < ?
     ORDER BY id DESC LIMIT ?`,
    formId, originPattern(origin), outcome === "all" ? "%" : outcome, before, limit + 1).all();
  const page = results.slice(0, limit);
  return {
    records: page.map(toRecord),
    next: results.length > limit ? encodeCursor(page[page.length - 1].id) : null,
  };
}

export async function getSubmission(db, { formId, origin, uid, toRecord }) {
  if (!UID.test(uid)) return null;
  const row = await select(db,
    `SELECT ${COLUMNS} FROM submissions WHERE form = ? AND uid = ? AND ${SAME_ORIGIN}`,
    formId, uid, originPattern(origin)).first();
  return row ? toRecord(row) : null;
}

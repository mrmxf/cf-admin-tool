/**
 * Just enough of the D1 binding for tests, on node:sqlite: prepare / bind /
 * first / all / run, and batch() as one transaction. Real SQLite, so the SQL in
 * src/ is exercised as written, RETURNING and ON CONFLICT included.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function fakeD1(...migrationFiles) {
  const db = new DatabaseSync(":memory:");
  for (const f of migrationFiles) db.exec(readFileSync(f, "utf8"));
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => db.prepare(s.sql).run(...s.args));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    sqlite: db,
  };
}

export const AUTH_MIGRATIONS = new URL("../db/migrations/0001_auth.sql", import.meta.url).pathname;
export const EVENTS_MIGRATIONS = [
  new URL("../db/migrations/0002_workflow_events.sql", import.meta.url).pathname,
  new URL("../db/migrations/0003_workflow_event_details.sql", import.meta.url).pathname,
];

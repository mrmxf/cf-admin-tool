/**
 * Settings (ADMIN_DB settings_events, db/migrations/0005). APPEND-ONLY: this
 * module has INSERTs and SELECTs and nothing else, on purpose. A setting's
 * value is its latest row; the rows before it are its history.
 *
 * Values are strings: the consumer checks and parses them (a number, say)
 * before appendSetting and after readSetting. Every row is per origin, so a
 * staging admin never changes the live site's settings.
 */

const KEY = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function checkKey(key) {
  if (!KEY.test(String(key ?? ""))) throw new Error(`setting key "${key}" must match ${KEY}`);
}

/** The latest {value, details, actor, at} of `key` on `origin`, or null if it was never set. */
export async function readSetting(db, { origin, key }) {
  checkKey(key);
  if (!db) return null;
  const row = await db.prepare(
    `SELECT value, details, actor, created_at AS createdAt FROM settings_events
     WHERE origin = ? AND key = ? ORDER BY id DESC LIMIT 1`,
  ).bind(origin, key).first();
  return row ? { value: row.value, details: row.details, actor: row.actor, at: new Date(row.createdAt * 1000).toISOString() } : null;
}

/** Every change of `key` on `origin`, newest first. */
export async function settingHistory(db, { origin, key, limit = 50 }) {
  checkKey(key);
  if (!db) return [];
  const { results = [] } = await db.prepare(
    `SELECT value, details, actor, created_at AS createdAt FROM settings_events
     WHERE origin = ? AND key = ? ORDER BY id DESC LIMIT ?`,
  ).bind(origin, key, limit).all();
  return results.map((r) => ({ value: r.value, details: r.details, actor: r.actor, at: new Date(r.createdAt * 1000).toISOString() }));
}

/** Append a new value. `actor` is the signed-in admin; `details`, why. */
export async function appendSetting(db, { origin, key, value, details = "", actor }) {
  checkKey(key);
  if (typeof value !== "string" || value.length > 1000) throw new Error("setting value must be a string of at most 1000 characters");
  if (typeof details !== "string" || details.length > 1000) throw new Error("setting details must be a string of at most 1000 characters");
  if (typeof actor !== "string" || !actor) throw new Error("setting actor is required");
  await db.prepare(
    `INSERT INTO settings_events (origin, key, value, details, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(origin, key, value, details, actor, Math.floor(Date.now() / 1000)).run();
}

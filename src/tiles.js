/**
 * Dashboard tiles. The dashboard is made of tiles and nothing else: the core's
 * own (the health summary) and whatever each plugin's dashboard() returns.
 *
 * A TILE is a plain object, rendered by the one `dashboardTile` template:
 *
 *   { id:    "forms",                  [a-z0-9-], unique on the dashboard
 *     title: "Forms",                  its heading; also its sort key
 *     href:  "/admin/forms",           optional: the heading links here
 *     lines: ["12 submissions", ...],  optional: strings or html``, one <p> each
 *     tone:  "ok" | "warn" | "bad" }   optional: the colour of its edge
 *
 * ORDER: config.dashboard.order lists tile ids to put first, in that order;
 * every other tile follows alphabetically by title, any leading emoji or
 * symbols ignored ("🅿️status" sorts as "status").
 */

const ID = /^[a-z0-9-]{1,40}$/;
const TONES = new Set(["ok", "warn", "bad"]);

/** The tile, checked, or null (with the reason logged) - one bad tile never takes the dashboard down. */
export function checkTile(t, from) {
  const bad = (why) => { console.log(`[admin] ${from}: tile dropped - ${why}`); return null; };
  if (!t || typeof t !== "object" || Array.isArray(t)) return bad("not an object");
  if (!ID.test(t.id ?? "")) return bad(`id "${t.id}" must match ${ID}`);
  if (typeof t.title !== "string" || !t.title.trim()) return bad(`tile "${t.id}" needs a title`);
  if (t.href !== undefined && (typeof t.href !== "string" || !t.href.startsWith("/") || t.href.startsWith("//"))) {
    return bad(`tile "${t.id}" href must be a path on this site`);
  }
  if (t.lines !== undefined && !Array.isArray(t.lines)) return bad(`tile "${t.id}" lines must be an array`);
  if (t.tone !== undefined && !TONES.has(t.tone)) return bad(`tile "${t.id}" tone must be ok, warn or bad`);
  return { id: t.id, title: t.title.trim(), href: t.href, lines: t.lines ?? [], tone: t.tone };
}

/** The title without its leading emoji or symbols: what tiles sort by. */
export const sortKey = (title) => String(title).replace(/^[^\p{L}\p{N}]+/u, "");

/** `order` ids first, as listed; the rest alphabetically by sortKey. Duplicate ids: the first wins. */
export function sortTiles(tiles, order = []) {
  const seen = new Set();
  const unique = tiles.filter((t) => t && !seen.has(t.id) && seen.add(t.id));
  const rank = (t) => { const i = order.indexOf(t.id); return i === -1 ? order.length : i; };
  return unique.sort((a, b) => rank(a) - rank(b)
    || sortKey(a.title).localeCompare(sortKey(b.title), "en", { sensitivity: "base" }));
}

/** The core's tile: the health checks, summed up. The table itself is at <root>/checks. */
export function healthTile(checks, { title, href }) {
  const failing = checks.filter((c) => c.ok === false).length;
  const unknown = checks.filter((c) => c.ok !== true && c.ok !== false).length;
  const lines = [failing ? `❌ ${failing} of ${checks.length} checks failing`
    : unknown ? `✅ ${checks.length - unknown} checks pass` : `✅ all ${checks.length} checks pass`];
  if (unknown) lines.push(`❓ ${unknown} unknown`);
  return { id: "admin-health", title, href, lines, tone: failing ? "bad" : unknown ? "warn" : "ok" };
}

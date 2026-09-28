/**
 * Date display for the admin pages, in config.timeZone:
 *
 *   fmtDate("2026-09-27T12:15:00Z")      -> "2026-09-27"
 *   fmtDateTime("2026-09-27T12:15:00Z")  -> "2026-09-27 @ 13:15"   (Europe/London, BST)
 *
 * Year-first and 24-hour whatever the site's language: the same string in every
 * table, and it sorts as text. Anything that is not a date comes back as given.
 */
export function dateFormatters(timeZone = "UTC") {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = (iso) => {
    const d = new Date(iso);
    if (iso == null || Number.isNaN(d.getTime())) return null;
    return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  };
  const fmtDate = (iso) => {
    const p = parts(iso);
    return p ? `${p.year}-${p.month}-${p.day}` : String(iso ?? "");
  };
  const fmtDateTime = (iso) => {
    const p = parts(iso);
    return p ? `${p.year}-${p.month}-${p.day} @ ${p.hour}:${p.minute}` : String(iso ?? "");
  };
  return { fmtDate, fmtDateTime };
}

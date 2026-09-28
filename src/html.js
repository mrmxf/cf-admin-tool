/**
 * HTML templating: a tagged template that escapes everything it is given.
 *
 *   html`<p>${name}</p>`           name is escaped
 *   html`<ul>${items.map(...)}</ul>` arrays are joined; html`` results pass through
 *   raw(trustedString)             the only way to skip escaping
 *
 * Escaping is the default and not an option because the admin area shows what
 * members of the public typed into a form. One missed esc() is stored XSS on
 * the page with the most access.
 */

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** Mark a string as already-safe HTML. Never pass it anything a visitor wrote. */
export const raw = (s) => new Safe(String(s ?? ""));

function render(v) {
  if (v == null || v === false) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

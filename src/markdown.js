/**
 * Just enough Markdown for a workflow's response email, and safe by construction:
 * every character of text is HTML-escaped BEFORE any markup is added, so neither
 * the template nor a submitter's answer filled into it can inject HTML.
 *
 *   # / ## / ###  heading           - item   list (every line of the block)
 *   **bold**   *em* or _em_         [text](https://...)  link: http, https, mailto only
 *   blank line = new paragraph; a single newline = a line break
 *   \* \_ \[ ... a backslash makes the next character literal
 *
 * `styles` puts inline style="" on each element (tag -> CSS), because email
 * clients ignore most <style> blocks. The same output is the in-page preview.
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Make a value literal inside Markdown: for filling answers into a template. */
export const escapeMd = (s) => String(s ?? "").replace(/[\\`*_[\]]/g, "\\$&").replace(/^(#|- )/gm, "\\$1");

/**
 * "{{name}}" -> values.name, through `esc` (Markdown-escaped by default; pass
 * String for plain text such as a subject line). Unknown names are left showing.
 */
export const fill = (template, values, esc = escapeMd) =>
  String(template).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) =>
    (Object.hasOwn(values, k) ? esc(values[k]) : m));

export function renderMarkdown(md, styles = {}) {
  const st = (tag) => (styles[tag] ? ` style="${escHtml(styles[tag])}"` : "");

  const inline = (text) => {
    // 1. Backslash escapes out of the way, as private-use placeholders.
    const lits = [];
    let s = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, (_, c) => `\uE000${lits.push(c) - 1}\uE001`);
    // 2. Escape everything; from here on nothing typed can be markup.
    s = escHtml(s);
    // 3. Add ours.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const url = href.replace(/&amp;/g, "&");
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return m;
      return `<a href="${escHtml(url)}"${st("a")}>${label}</a>`;
    });
    s = s.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, `<strong>$1</strong>`);
    s = s.replace(/(^|[^*\w])\*(\S(?:.*?\S)?)\*(?!\*)/g, `$1<em>$2</em>`);
    s = s.replace(/(^|[^_\w])_(\S(?:.*?\S)?)_(?!\w)/g, `$1<em>$2</em>`);
    // 4. The literals back, escaped.
    return s.replace(/\uE000(\d+)\uE001/g, (_, i) => escHtml(lits[i]));
  };

  return String(md ?? "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map((b) => b.replace(/^\n+|\s+$/g, ""))
    .filter(Boolean)
    .map((block) => {
      const h = block.match(/^(#{1,3})\s+(.+)$/);
      if (h && !block.includes("\n")) return `<h${h[1].length}${st(`h${h[1].length}`)}>${inline(h[2])}</h${h[1].length}>`;
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul${st("ul")}>${lines.map((l) => `<li${st("li")}>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p${st("p")}>${lines.map(inline).join("<br>")}</p>`;
    }).join("\n");
}

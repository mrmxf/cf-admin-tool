/**
 * Just enough Markdown for a workflow's response email, and safe by construction:
 * every character of text is HTML-escaped BEFORE any markup is added, so neither
 * the template nor a submitter's answer filled into it can inject HTML.
 *
 *   # / ## / ###  heading           - item   list       1. item   numbered list
 *   **bold**   *em* or _em_         ~~struck~~          > quote   --- a rule
 *   ^sup^   ~sub~  (no spaces inside)
 *   [text](https://...)  link: http, https, mailto only
 *   blank line = new paragraph; a single newline is just a space, as in CommonMark
 *   a line ending in \ or two spaces = a line break
 *   \* \_ \[ ... a backslash makes the next character literal
 *
 * A list, quote, heading or rule needs no blank line before it. A numbered list
 * that interrupts a paragraph must start at 1, so a wrapped "2026. The next..."
 * stays text. A line with no marker continues the list item or quote above it.
 *
 * `styles` puts inline style="" on each element (tag -> CSS), because email
 * clients ignore most <style> blocks. The same output is the in-page preview.
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const HEADING = /^ {0,3}(#{1,3})\s+(.+?)\s*$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,9})\.\s+(.*)$/;

const LITERAL = "\\\\([\\\\`*_{}[\\]()#+\\-.!|>~^<])";
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD = /\*\*(\S(?:.*?\S)?)\*\*/g;
const EM_STAR = /(^|[^*\w])\*(\S(?:.*?\S)?)\*(?!\*)/g;
const EM_UNDER = /(^|[^_\w])_(\S(?:.*?\S)?)_(?!\w)/g;
const STRUCK = /~~(\S(?:.*?\S)?)~~/g;
const SUP = /\^([^\s^]+)\^/g;
const SUB = /(?<!~)~([^\s~]+)~(?!~)/g;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

const normalise = (md) => String(md ?? "").replace(/\r\n?/g, "\n").replace(/[]/g, "");
const unstash = (s, stash) => s.replace(/(\d+)/g, (_, i) => stash[i]);

/** Make a value literal inside Markdown: for filling answers into a template. */
export const escapeMd = (s) => String(s ?? "")
  .replace(/[\\`*_[\]^~]/g, "\\$&")
  .replace(/^(#|>|- |---)/gm, "\\$1")
  .replace(/^(\d+)\. /gm, "$1\\. ");

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
    // 1. Backslash escapes and line breaks out of the way, as private-use
    //    placeholders; a newline left after that is only a space.
    const stash = [];
    const keep = (markup) => `${stash.push(markup) - 1}`;
    let s = text.replace(new RegExp(`${LITERAL}|(?: {2,}|\\\\)\\n`, "g"), (_, c) => keep(c ? escHtml(c) : "<br>"))
      .replace(/\s*\n\s*/g, " ");
    // 2. Escape everything; from here on nothing typed can be markup.
    s = escHtml(s);
    // 3. Add ours. A link's opening tag is stashed so its URL is never read as emphasis.
    s = s.replace(LINK, (m, label, href) => {
      const url = href.replace(/&amp;/g, "&");
      if (!SAFE_URL.test(url)) return m;
      return `${keep(unstash(`<a href="${escHtml(url)}"${st("a")}>`, stash))}${label}</a>`;
    });
    s = s.replace(BOLD, `<strong>$1</strong>`);
    s = s.replace(EM_STAR, `$1<em>$2</em>`);
    s = s.replace(EM_UNDER, `$1<em>$2</em>`);
    s = s.replace(STRUCK, (_, t) => `<del${st("del")}>${t}</del>`);
    s = s.replace(SUP, (_, t) => `<sup${st("sup")}>${t}</sup>`);
    s = s.replace(SUB, (_, t) => `<sub${st("sub")}>${t}</sub>`);
    // 4. The placeholders back.
    return unstash(s, stash);
  };

  const out = [];
  let open = null; // the block being read: {tag, items, start}
  const close = () => {
    if (!open) return;
    const { tag, items, start } = open;
    open = null;
    const text = items.map((i) => inline(i.trimEnd()));
    if (tag === "p" || tag === "blockquote") out.push(`<${tag}${st(tag)}>${text[0]}</${tag}>`);
    else out.push(`<${tag}${start ? ` start="${Number(start)}"` : ""}${st(tag)}>${text.map((t) => `<li${st("li")}>${t}</li>`).join("")}</${tag}>`);
  };
  const begin = (tag, text, start = "") => { close(); open = { tag, items: [text], start }; };
  const more = (text) => { open.items[open.items.length - 1] += `\n${text}`; };

  for (const line of normalise(md).split("\n")) {
    let m;
    if (!line.trim()) close();
    else if ((m = line.match(HEADING))) {
      close();
      out.push(`<h${m[1].length}${st(`h${m[1].length}`)}>${inline(m[2])}</h${m[1].length}>`);
    } else if (RULE.test(line)) {
      close();
      out.push(`<hr${st("hr")}>`);
    } else if ((m = line.match(QUOTE))) {
      if (open?.tag === "blockquote") more(m[1]);
      else begin("blockquote", m[1]);
    } else if ((m = line.match(BULLET))) {
      if (open?.tag === "ul") open.items.push(m[1]);
      else begin("ul", m[1]);
    } else if ((m = line.match(NUMBER)) && (open?.tag !== "p" || m[1] === "1")) {
      if (open?.tag === "ol") open.items.push(m[2]);
      else begin("ol", m[2], m[1] === "1" ? "" : m[1]);
    } else if (open) more(line.trimStart());
    else begin("p", line.trimStart());
  }
  close();
  return out.join("\n");
}

/**
 * The same Markdown as the email's plain-text part: readable as typed, with the
 * markers a reader would stumble over gone. ~~struck~~ stays, or a struck word
 * would read as meant. Line breaks stay where they were typed.
 */
export function markdownText(md) {
  const stash = [];
  const keep = (c) => `${stash.push(c) - 1}`;
  const s = normalise(md)
    .replace(new RegExp(`${LITERAL}|\\\\$|[ \\t]+$`, "gm"), (_, c) => (c ? keep(c) : ""))
    .replace(LINK, (m, label, href) => {
      if (!SAFE_URL.test(href)) return m;
      return label === href ? href : `${label} (${href})`;
    })
    .replace(BOLD, "$1").replace(EM_STAR, "$1$2").replace(EM_UNDER, "$1$2")
    .replace(SUP, "$1").replace(SUB, "$1");
  return unstash(s, stash);
}

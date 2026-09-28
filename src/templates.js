/**
 * The core templates: the page, sign-in, the dashboard and messages. Plugins
 * add their own (formsPlugin: plugins/forms-templates.js). A consumer overrides
 * ANY template, core or plugin, BY NAME through config.templates.
 *
 * Every template is (ctx, data) => html`...`:
 *
 *   ctx.site      the consumer's site.js (name, url, lang, fonts, theme)
 *   ctx.copy      wording: DEFAULT_COPY merged with config.copy
 *   ctx.root      the admin root, e.g. "/admin"
 *   ctx.base      in a plugin's pages: root + the plugin's path, e.g. "/admin/forms"
 *   ctx.nav       [{href, label}] - one per plugin with a label, for the header
 *   ctx.user      {email} when signed in, else null
 *   ctx.secondFactor  config.requireSecondFactor (default true)
 *   ctx.t         the merged template set - call ctx.t.<name> so that an
 *                 override of one template is used by all the others
 *   ctx.fmtTime   ISO string -> local display string (config.timeZone)
 *   ctx.fmtDate / ctx.fmtDateTime   ISO -> "2026-09-27" / "2026-09-27 @ 13:15"
 *   ctx.host      the host this page is on
 *   ctx.liveHost  site.url's host
 *   ctx.isLive    host === liveHost
 *
 * Use html`` for everything; its escaping is what makes it safe to display
 * what the public typed into a form. raw() only for markup you wrote.
 *
 * Styling: the eleven colour tokens of cf-form-mailer's site.js theme, the same
 * tokens and the same rule for one block (fixed) or two (follow the OS).
 */

import { html, raw } from "./html.js";

export const DEFAULT_COPY = {
  title: "Admin",
  loginHeading: "Sign in",
  loginIntro: "Enter your email address. If it is on the admin list, a code will be emailed to it.",
  emailCodeHeading: "Check your email",
  emailCodeIntro: "If that address is on the admin list, a six-digit code is on its way to it. It expires in 10 minutes.",
  ntfyCodeHeading: "Check your phone",
  ntfyCodeIntro: "A second six-digit code has been sent to the ntfy app on your phone. It expires in 5 minutes.",
  dashboardIntro: "",
  formsIntro: "Submissions made on this domain.",
  notLiveLabel: "Not the live site",
};

export const TOKENS = ["primary", "primary-hover", "on-primary", "error", "error-bg",
  "bg", "surface", "body", "meta", "link", "border"];

const tokenBlock = (t) => TOKENS.map((k) => `--${k}: ${t[k]};`).join(" ");

function themeCss(theme = {}) {
  const { light, dark } = theme;
  if (light && dark) {
    return `:root { ${tokenBlock(light)} color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { ${tokenBlock(dark)} } }`;
  }
  return `:root { ${tokenBlock(light || dark)} color-scheme: ${dark ? "dark" : "light"}; }`;
}

const styles = (site) => `
  ${themeCss(site.theme)}
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--body);
    font-family: ${site.fonts?.body ?? "system-ui, sans-serif"}; font-size: 16px; line-height: 1.6; }
  .wrap { max-width: 64rem; margin: 0 auto; padding: 0 1rem 4rem; }
  .narrow { max-width: 28rem; }
  .env-banner { background: var(--error-bg); color: var(--error); border-bottom: 4px solid var(--error);
    font-weight: 700; }
  .env-banner .wrap { padding: .5rem 1rem; }
  .env-banner strong { text-transform: uppercase; letter-spacing: .08em; }
  header.bar { background: var(--primary); color: var(--on-primary); }
  header.bar .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.5rem; padding: .75rem 1rem; }
  header.bar a { color: var(--on-primary); }
  header.bar .brand { font-family: ${site.fonts?.heading ?? "inherit"}; font-weight: 700; font-size: 1.15rem; text-decoration: none; }
  header.bar nav { display: flex; gap: 1rem; flex: 1; }
  header.bar form { margin: 0; }
  header.bar .who { font-size: .875rem; }
  h1, h2, h3 { font-family: ${site.fonts?.heading ?? "inherit"}; font-weight: 700; line-height: 1.25; }
  h1 { font-size: 1.75rem; margin: 2rem 0 .5rem; }
  h2 { font-size: 1.3rem; margin: 2rem 0 .75rem; }
  a { color: var(--link); }
  .meta { color: var(--meta); }
  label { display: block; font-weight: 700; margin: 1rem 0 .25rem; }
  input[type=email], input[type=text] { width: 100%; padding: .65rem .75rem; border: 1px solid var(--border);
    border-radius: 4px; font: inherit; color: var(--body); background: var(--surface); }
  input.code { font-size: 1.5rem; letter-spacing: .3em; font-variant-numeric: tabular-nums; max-width: 12rem; }
  :focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
  button { font: inherit; font-weight: 700; border: none; border-radius: 300px; padding: .7rem 1.6rem;
    color: var(--on-primary); background: var(--primary); cursor: pointer; margin-top: 1.25rem; }
  button:hover { background: var(--primary-hover); }
  button.link { background: none; color: inherit; padding: 0; margin: 0; border-radius: 0;
    font-weight: 400; text-decoration: underline; }
  .error { border-left: 4px solid var(--error); background: var(--error-bg); color: var(--error);
    padding: .6rem 1rem; font-weight: 700; }
  .notice { border-left: 4px solid var(--primary); background: var(--surface); padding: .6rem 1rem; }
  .cf-turnstile { margin-top: 1.25rem; min-height: 65px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .tile { background: var(--surface); border-left: 4px solid var(--primary); padding: 1rem 1.25rem; }
  .tile h3 { margin: 0 0 .35rem; font-size: 1.1rem; }
  .tile p { margin: .25rem 0; }
  .big { font-size: 2rem; font-weight: 700; line-height: 1.1; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9375rem; }
  th, td { text-align: left; vertical-align: top; padding: .45rem .6rem; border-bottom: 1px solid var(--border); }
  th { color: var(--meta); font-weight: 700; }
  td.wrap-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .status { font-weight: 700; white-space: nowrap; }
  .status.ok::before { content: "\\2713  "; }
  .status.bad { color: var(--error); }
  .status.bad::before { content: "\\2717  "; }
  .status.unknown { color: var(--meta); }
  .status.unknown::before { content: "?  "; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin: .5rem 0 1rem; }
  .filters [aria-current] { font-weight: 700; color: var(--body); text-decoration: none; }
  fieldset { border: 1px solid var(--border); padding: .75rem 1rem 1rem; }
  legend { font-weight: 700; padding: 0 .35rem; }
  .tile .count { font-weight: 700; margin-top: .5rem; }
  table.compact { font-size: 1rem; }
  .compact th { font-family: ${site.fonts?.heading ?? "inherit"}; font-size: 1em; white-space: nowrap; }
  .compact td { font-size: .8em; white-space: nowrap; vertical-align: middle; padding: .3rem .6rem; }
  form.inline { display: inline; margin: 0; }
  button.run { margin: 0; padding: .1rem .9rem; font-size: 1em; }
  button:disabled, button:disabled:hover { background: var(--surface); color: var(--meta);
    box-shadow: inset 0 0 0 1px var(--border); cursor: not-allowed; }
  button.secondary { background: var(--surface); color: var(--body); box-shadow: inset 0 0 0 1px var(--border); }
  button.secondary:hover { background: var(--bg); }
  .actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-top: 1.25rem; }
  .actions button { margin: 0; }
  textarea { width: 100%; padding: .65rem .75rem; border: 1px solid var(--border); border-radius: 4px;
    font: .9375rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--body); background: var(--surface); }
  .mail-preview { border: 1px solid var(--border); overflow: auto; color-scheme: light; }
  dl.pairs { display: grid; grid-template-columns: auto 1fr; gap: .25rem 1rem; margin: .5rem 0 1rem; }
  dl.pairs dt { font-weight: 700; color: var(--meta); }
  dl.pairs dd { margin: 0; overflow-wrap: anywhere; }
  .wf-list p { margin: .5rem 0; }
  pre { background: var(--surface); padding: .75rem 1rem; overflow-x: auto; font-size: .875rem; }

  /* A data page: the full width, 2em each side. */
  .wrap.wide { max-width: none; padding: 0 2em 4rem; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .compact td.eye, .compact th.eye, .compact .d-short, .compact .n-short { display: none; }
  button.eye-btn { margin: 0; padding: .25rem .4rem; background: none; color: var(--link); border-radius: 4px; line-height: 0; }
  button.eye-btn:hover { background: var(--surface); }
  button.eye-btn svg { width: 1.35rem; height: 1.35rem; }
  .viewer { background: var(--bg); color: var(--body); border: 1px solid var(--border); border-radius: 6px;
    padding: 1rem 1.25rem; width: min(40rem, calc(100vw - 2rem)); max-height: 85vh; overflow: auto; }
  .viewer::backdrop { background: oklch(0% 0 0 / .6); }
  .viewer h2 { margin-top: 0; }
  .viewer th { white-space: nowrap; }
  .viewer td { overflow-wrap: anywhere; }
  @media (max-width: 50rem) {
    .wrap.wide { padding: 0 1rem 4rem; }
    table.compact { width: 100%; }
    .compact .w, .compact .d-full, .compact .n-full { display: none; }
    .compact td.eye, .compact th.eye { display: table-cell; width: 1%; }
    .compact .d-short, .compact .n-short { display: inline; }
    .compact .fill { width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; }
  }
`;

function status(ok) {
  if (ok === true) return html`<span class="status ok">OK</span>`;
  if (ok === false) return html`<span class="status bad">Problem</span>`;
  return html`<span class="status unknown">Unknown</span>`;
}

export const DEFAULT_TEMPLATES = {
  /** The whole page. data: {title, body, turnstile} */
  layout: (ctx, { title, body, turnstile = false, wide = false }) => html`<!doctype html>
<html lang="${ctx.site.lang || "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title} · ${ctx.copy.title} · ${ctx.site.name}</title>
  ${ctx.site.fonts?.href ? html`<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${ctx.site.fonts.href}" rel="stylesheet">` : ""}
  <style>${raw(styles(ctx.site))}</style>
  ${turnstile ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
</head>
<body>
  ${ctx.t.envBanner(ctx)}
  ${ctx.t.header(ctx)}
  <main class="wrap${wide ? " wide" : ""}">
${body}
  </main>
</body>
</html>`,

  /** On any host but site.url's: which data this is. Nothing on the live site. */
  envBanner: (ctx) => (ctx.isLive ? "" : html`<div class="env-banner" role="note"><div class="wrap">
    <strong>${ctx.copy.notLiveLabel}</strong> · ${ctx.host} - only data made on this host is shown, not that on ${ctx.liveHost}.
  </div></div>`),

  header: (ctx) => html`<header class="bar"><div class="wrap">
    <a class="brand" href="${ctx.root}">${ctx.site.name} · ${ctx.copy.title}</a>
    ${ctx.user ? html`<nav aria-label="Admin">
      <a href="${ctx.root}">Dashboard</a>${ctx.nav.map((n) => html`
      <a href="${n.href}">${n.label}</a>`)}
    </nav>
    <span class="who">${ctx.user.email}</span>
    <form method="post" action="${ctx.root}/logout"><button class="link" type="submit">Sign out</button></form>`
    : html`<nav aria-label="Site"><a href="${ctx.site.url}">${new URL(ctx.site.url).host}</a></nav>`}
  </div></header>`,

  /** data: {error, email} */
  loginEmail: (ctx, { error = "", email = "", siteKey = "" }) => html`<div class="narrow">
    <h1>${ctx.copy.loginHeading}</h1>
    <p class="meta">${ctx.copy.loginIntro}</p>
    ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
    <form method="post" action="${ctx.root}/login">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" autocomplete="email" required value="${email}" autofocus>
      <div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="${ctx.site.theme?.light ? "auto" : "dark"}"></div>
      <button type="submit">Email me a code</button>
    </form>
  </div>`,

  /** data: {stage: "email" | "ntfy", error, notice} */
  loginCode: (ctx, { stage, error = "", notice = "" }) => html`<div class="narrow">
    <h1>${stage === "ntfy" ? ctx.copy.ntfyCodeHeading : ctx.copy.emailCodeHeading}</h1>
    <p class="meta">${stage === "ntfy" ? ctx.copy.ntfyCodeIntro : ctx.copy.emailCodeIntro}</p>
    ${ctx.secondFactor ? html`<p class="meta">Step ${stage === "ntfy" ? "2" : "1"} of 2.</p>` : ""}
    ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
    ${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
    <form method="post" action="${ctx.root}/login/code">
      <label for="code">${stage === "ntfy" ? "Code from the ntfy app" : "Code from the email"}</label>
      <input id="code" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
             maxlength="32" required autofocus>
      <button type="submit">Continue</button>
    </form>
    ${stage === "ntfy" ? html`<form method="post" action="${ctx.root}/login/resend">
      <p><button class="link" type="submit">Send a new phone code</button></p>
    </form>` : ""}
    <p><a href="${ctx.root}/login">Start again</a></p>
  </div>`,

  /**
   * data: {checks, cards} - `cards` is what each plugin's dashboard() returned
   * (a .tile each, by convention), in plugin order.
   */
  dashboard: (ctx, { checks, cards = [] }) => html`
    <h1>Dashboard</h1>
    ${ctx.copy.dashboardIntro ? html`<p class="meta">${ctx.copy.dashboardIntro}</p>` : ""}
    ${cards.length ? html`<h2>Options</h2>
    <div class="tiles">${cards}</div>` : ""}
    <h2>Health</h2>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
      <tbody>${checks.map((c) => html`<tr><td>${c.name}</td><td>${status(c.ok)}</td><td>${c.detail}</td></tr>`)}</tbody>
    </table></div>`,

  /** data: {heading, text, back} - `back` defaults to the dashboard */
  message: (ctx, { heading, text, back = "" }) => html`<h1>${heading}</h1><p>${text}</p>
    <p><a href="${back || ctx.root}">${back ? "Back" : "Back to the dashboard"}</a></p>`,
};

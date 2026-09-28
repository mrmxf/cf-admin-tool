# cf-admin-tool

A small admin area for a static site, as a Cloudflare Worker: a sign-in for an
allowlist of people (an emailed code, optionally a second code by push), a
dashboard, and a router that mounts **plugins** - Worker-shaped handlers that
only ever see signed-in requests.

One plugin ships with it: `formsPlugin`, a read-only browser over the
submission log written by [cf-form-mailer](https://github.com/mrmxf/cf-form-mailer),
with views and workflows.

No dependencies. BSD-3-Clause.

## Using it

```js
import { createAdmin, formsPlugin, approvalWorkflow } from "@mrmxf/cf-admin-tool";
import { toRecord } from "@mrmxf/cf-form-mailer";
import { SITE } from "../../site.js";          // the same site.js the forms use

export default createAdmin({
  root: "/admin",                               // ADMIN_ROOT var overrides
  site: SITE,                                   // name, url, lang, fonts, theme (11 tokens)
  timeZone: "Europe/London",                    // how times are shown
  requireSecondFactor: true,                    // the push code after the emailed one
  copy: { dashboardIntro: "..." },              // any key of DEFAULT_COPY
  templates: { header: (ctx) => html`...` },    // any template, core or plugin, by name
  plugins: [
    formsPlugin({
      toRecord,                                 // required: the engine's row -> record
      list: [{ id: "contact", label: "Contact", path: "/forms/contact", service: "FORM_CONTACT" }],
      workflows: [{ id: "reply", label: "Reply", description: "...", forms: ["contact"] }],
      views: [{ id: "contact", label: "Contact", form: "contact",
        columns: [{ label: "Email", answer: "email" }, { label: "Reply", workflow: "reply" }] }],
    }),
  ],
});
```

Install it pinned to a tag, as the form engine is: `"@mrmxf/cf-admin-tool": "github:mrmxf/cf-admin-tool#0.2.0"`.
Tags have no leading `v`.

## Routes

| Route | Signed in | What |
|---|---|---|
| `GET <root>/health` | no | JSON flags only: `adminDb`, `usersConfigured`, `mailConfigured`, `turnstileConfigured`, `dryRun`, `secondFactor`, plus each plugin's `flags()` |
| `GET/POST <root>/login` | no | step 0: email address + Turnstile |
| `GET/POST <root>/login/code` | no | step 1: the emailed code; step 2: the push code |
| `POST <root>/login/resend` | no | a new push code (second factor on only) |
| `POST <root>/logout` | yes | |
| `GET <root>` | yes | the dashboard: each plugin's tile, and a health table |
| `* <root><plugin.path>/...` | yes | the plugin's `fetch()` |

There is no public plugin route.

## Plugins

A plugin is an object shaped like a Worker, mounted at ONE path segment:

```js
const notes = {
  id: "notes",                    // [a-z0-9-], unique
  path: "/notes",                 // <root>/notes/...; not /login, /logout, /health
  label: "Notes",                 // a link in the header nav (omit for none)

  // Required with `path`. The usual Worker signature plus `admin`. Return a
  // Response, or null for the admin's own 404 page.
  async fetch(request, env, ctx, admin) {
    if (admin.path !== "/") return null;
    return admin.page("Notes", admin.t.notesPage(admin.c, { who: admin.user.email }));
  },

  async dashboard(env, admin) { return html`<div class="tile">...</div>`; },  // optional
  async health(env, admin) { return [{ name: "Notes", ok: true, detail: "fine" }]; }, // optional
  async flags(env) { return { notesDb: true }; },                             // optional, PUBLIC
  templates: { notesPage: (ctx, { who }) => html`<h1>Notes for ${who}</h1>` }, // optional defaults
};
```

`admin` is:

| | |
|---|---|
| `user` | `{email}` - always set: a plugin is only called for a signed-in user |
| `root`, `base` | `/admin`, and `/admin/notes` (root + path) |
| `path` | the path inside the mount, `/` at least: `/admin/notes/a/b` gives `/a/b` |
| `url` | the request's `URL` |
| `c`, `t` | the template context (`c.base` is the plugin's) and the merged template set |
| `page(title, body, {status, wide})` | a whole page in the admin's layout, with its headers |
| `redirect(location)`, `notFound()` | |

Templates a plugin ships are defaults: `config.templates` overrides them by
name, like the core's. A throw from `fetch()` is logged and becomes a generic
503; from `dashboard()` or `health()`, a failed row in the health table.

**What the core enforces on every plugin** (see Security):

- `fetch()` runs only after the session check, for GET, HEAD and POST, and a
  POST only with the page's own `Origin`.
- The request it is given has the admin's cookies REMOVED, so a plugin that
  forwards it (to a service binding, say) cannot leak the session.
- Its response gets `cache-control: no-store`, `x-frame-options: DENY` and
  `x-content-type-options: nosniff` whatever it set, the admin CSP and referrer
  policy unless it set its own, and any `Set-Cookie` for the admin's cookies is
  dropped.
- Only top-level navigations reach it (Fetch Metadata): there is no script on
  admin pages, so no plugin endpoint can be `fetch()`ed from a browser.

## Signing in

1. The visitor types an email address. **Every** address gets a challenge, a
   cookie and the "check your email" page, and the same database work, so
   neither the page nor its timing says who is on the list. Only an address on
   `ADMIN_USERS` is actually sent a code: at most 3 per 15 minutes and 10 per
   day. The email is sent in `ctx.waitUntil`, after the response.
2. The six-digit email code. 5 wrong tries burn the challenge; it lasts 10
   minutes. 20 wrong codes in a day for one address lock it until the day is up
   (see Security).
3. With `requireSecondFactor` on (the default), a second code is pushed to the
   person's **ntfy** topic; 5 minutes, 5 tries. This push is awaited: if ntfy
   refuses it, the page says so, with ntfy's reason, and offers "Send a new
   phone code" (3 per sign-in). That reveals nothing: the email step has
   already proved the address.

   `requireSecondFactor: false` skips step 3: the emailed code alone signs in,
   no push is sent and `ntfyTopic` is optional. Every line of the second factor
   sits inside an `if (secondFactor) {}` block (auth.js `verifyCode`,
   handler.js), so a different channel replaces only those.
4. A session: 8 hours at most, 1 hour idle. `__Host-` cookies, HttpOnly, Secure,
   SameSite=Strict. Taking someone off `ADMIN_USERS` ends their session at the
   next request.

Codes and session tokens are stored only as SHA-256 hashes; rate limits are
keyed by a hash of the address. No IP address is stored anywhere.

`ADMIN_USERS` (a secret) is JSON:

```json
[{ "email": "someone@example.org", "ntfyTopic": "a-long-random-topic-name" }]
```

On ntfy.sh **the topic name is the password**: anyone who knows it can read that
person's codes. Make it long and random (`openssl rand -hex 16`), and keep it
only in the secret. For a self-hosted ntfy with access control, set
`NTFY_SERVER` and the `NTFY_TOKEN` secret. A malformed list means nobody can
sign in (fail closed); `/health` shows `usersConfigured: false`.

**ntfy.sh rate-limits by IP address** unless the account has a paid tier
(`GET /v1/account` with the token shows `limits.basis`: `ip` or `tier`). A
Worker's outbound requests come from Cloudflare addresses shared with other
Workers, so free ntfy.sh can answer `429`, and an access token on a free account
does not change that. The options are a paid ntfy.sh tier with `NTFY_TOKEN`, or
a self-hosted ntfy (`NTFY_SERVER` + `NTFY_TOKEN`).

## Security

**Serve the admin on its own hostname if the public site runs anyone else's
JavaScript.** The session cookie is `__Host-` (so `Path=/`) and SameSite=Strict:
it is sent with every request to the admin's hostname, and the browser treats
any page on that hostname as the same origin as the admin. Analytics, a chat
widget or a compromised dependency on the public site can therefore reach the
admin with a signed-in person's cookie. The core stops the quiet version (a
`fetch()` is refused by Fetch Metadata), but same-origin pages can still open an
admin page in a window they control and read it. Only a separate origin, e.g.
`admin.example.org`, closes that. The route (`routes` in `wrangler.jsonc`) and
`root` are the only things that change.

**Guessing.** A code is six digits. With 5 tries per challenge and 20 wrong
codes per address per day, an attacker who can pass Turnstile at will gets 20
guesses a day: about one chance in 50,000 per day. The price is that the same
attacker can spend an address's daily budget, or its 10 daily codes, and lock
its owner out until the next day. With `requireSecondFactor: false` this cap is
the whole defence; with it on, the push code is needed as well.

**Turnstile** is checked on the email step, and the token must have been solved
on the hostname the form was served on (skipped on localhost).

**Templates escape.** Each template is `(ctx, data) => html\`...\``. `html`
escapes every interpolation; `raw()` is the only way out and is for markup you
wrote, never for anything a visitor typed. The admin pages show what the public
typed, so one missed escape is stored XSS on the page with the most access.

**Headers.** Every page is `no-store`, unframeable, `nosniff`, and under a CSP
whose only script is Turnstile's. Every POST must carry the page's own `Origin`.

**Deploying.** Set `workers_dev: false` and `preview_urls: false` in the
Worker's `wrangler.jsonc`, so the admin answers only on its route. Keep
`DRY_RUN` off in deployed Workers; even on, it prints nothing and sends nothing
except on localhost.

## Env

| Name | Kind | |
|---|---|---|
| `ADMIN_DB` | D1 | login state, and formsPlugin's workflow log; this package's `db/migrations` |
| `ADMIN_USERS` | secret | the allowlist, above |
| `ADMIN_SENDER` | var | From: on the code email and, by default, on workflow emails (a verified Mailtrap sender) |
| `MAILTRAP_API_TOKEN` | secret | |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | var / secret | missing secret = no sign-in |
| `NTFY_SERVER` | var | default `https://ntfy.sh` |
| `NTFY_TOKEN` | secret | optional |
| `DRY_RUN` | var | `"true"`: codes and workflow emails printed to the console, **localhost only** |
| `ADMIN_ROOT` | var | optional override of `root` |
| `FORM_DB` | D1 | formsPlugin: the cf-form-mailer log, **read only** |
| any `list[].service` | service binding | formsPlugin: reaches that form's `/health` |

## formsPlugin

Mounted at `/forms` (option `path`):

| Route | What |
|---|---|
| `GET <root>/forms` | per form: total entries, most recent submission |
| `GET <root>/forms/views/<id>` | one of `views`: a compact table over one form, `?cursor=` |
| `GET <root>/forms/<id>` | browse, newest first, `?outcome=` `?cursor=` |
| `GET <root>/forms/<id>/<uid>` | one submission: answers, workflows (`#wf-<id>`), history, session signals |
| `GET/POST <root>/forms/<id>/<uid>/run/<wf>` | the workflow's pages ("WORKFLOW: <label>"); 409 if it has no `run()` |

- **Read only.** All its SQL on `FORM_DB` goes through `select()`, which refuses
  anything but one `SELECT`. The table and its migrations belong to cf-form-mailer.
- **Same origin.** Every query is limited to rows whose `url` is on the origin
  the admin is being viewed on, so a staging admin never shows production data.
- Rows are shaped by the consumer's `toRecord` (from cf-form-mailer), the one
  function that understands every `schema_version`.
- `views` cannot be a form id: it is where the views live.

### Views

A compact table over one form's submissions (`outcome`, default `sent`), newest
first, one row each, the full page width with 2em each side. The Forms page
links each form's card to its view. The linked "Submitted" column is always
first; each further column is ONE of `answer` (a field name), `value`
(`(record) => string`) or `workflow` (a workflow id offered on that form). An
empty cell is blank.

**Narrow screens** (under 50rem) show the date without the time, the columns
marked `narrow`, and an eye button. `narrow: 30` clips to 30 characters and an
ellipsis; `narrow: "fill"` (one per view) takes the remaining width. The eye
opens the whole row, transposed, as the wide table shows it - a `popover`, so no
script: the CSP allows none of ours.

A `workflow` cell is the workflow's latest event, its `statusMessage` linked to
the workflow on the submission page; before it has run, a button named after the
workflow, disabled while it has no `run()`. A bad view (unknown form or
workflow, duplicate id, two fills) throws at construction.

### Workflows

**A workflow changes nothing.** The only thing it can produce is one event:

```json
{ "event": "wf02-approve", "timestamp": "<when it was started, ISO>",
  "duration": 1234, "status": 201, "statusMessage": "✅ with mail",
  "details": "optional: why it ended as it did" }
```

`event` is the workflow id, optionally `-<decorator>`; `duration` is whole
milliseconds, rounded up; `status` is an HTTP status code; `statusMessage` is
what the tables show. The tool checks it (`checkEvent`) and appends it, with who
ran it, to `workflow_events` in `ADMIN_DB` - append-only, never updated or
deleted (a new field is a new migration). Readers take the latest event per
workflow: a record's own `workflow.events` (cf-form-mailer's "submit") followed
by the logged ones. It is in `ADMIN_DB` because `FORM_DB` is the engine's and
read-only here. A malformed event is refused and nothing is logged.

A workflow is `{ id, label, description, forms, run }`; the contract for `run`
is at the top of `src/workflows.js`. Without `run` it is a disabled button.

#### approvalWorkflow

```js
approvalWorkflow({ id: "wf02", label: "Approval", forms: ["requests"],
  emailField: "email", replyToVar: "REQUESTS_RECIPIENT",
  templates: { approve: { subject, body }, deny: { subject, body } } })
```

1. The submission, **Approve** / **Deny**. The start time is set here.
2. "Send response to submitter": the Markdown template, `{{field}}` already
   filled from the answers (plus `{{site_name}}`, `{{site_url}}`,
   `{{submitted_date}}`), editable, with a light-mode preview of the email.
   **Send** / **Don't send** / **Update preview** (shows the edits; nothing
   logged) / **Back** (to step 1; nothing logged).
3. The event: `201 "✅ with mail"`, `202 "✅ silent"`, `400 "❌ with mail"`,
   `422 "❌ silent"`. A send that fails logs `500 "☠️ failed"` with the reason in
   `details`, and shows step 2 again to retry or not send. The submission page
   always has the workflow's button, so it can be run again.

The Markdown is a small safe subset (`src/markdown.js`): every character is
HTML-escaped before markup is added, and filled-in answers are made literal, so
nothing a submitter typed becomes markup. Plain URLs a submitter typed stay in
the text, and mail clients may make them links: read the preview before Send.

## Templates and dates

Call other templates as `ctx.t.<name>` so an override of one is used
everywhere. Styling is the eleven colour tokens of the site's `site.js`: one
theme block is fixed, two follow the OS. `ctx.nav` is the header's plugin links.

`ctx.fmtDate` and `ctx.fmtDateTime` give `2026-09-27` and `2026-09-27 @ 13:15`
in `config.timeZone`, for any template. `dateFormatters(timeZone)` is exported.

## Tests

```bash
npm test      # node >= 22.18; uses node:sqlite as a stand-in for D1
```

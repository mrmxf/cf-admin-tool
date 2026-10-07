# AGENTS.md — cf-admin-tool

Instructions for any coding agent working in this repo. `CLAUDE.md` points here; keep
this file the only copy.

A Cloudflare Worker admin area: one npm package, consumed by a site's
`cf_tools/cf-admin/` Worker, which supplies only its site.js, wording, plugins and
their config. No dependencies.

`npm test` is the only gate. There is no build and no type-check. It must pass before
any commit.

Usage, routes, the plugin interface and the security model are [README.md](README.md).
Do not repeat them here.

## Layout

```
AGENTS.md          this file. CLAUDE.md is a pointer to it — never a second copy
index.js           the public entry point — every export goes through it
src/handler.js     createAdmin: sign-in routes, the dashboard, the plugin router,
                   and everything the core enforces on plugins
src/auth.js        challenges, codes, sessions, rate limits (ADMIN_DB)
src/deliver.js     the code email (Mailtrap), the push code (ntfy), sendMail
src/turnstile.js   siteverify, with the hostname check
src/html.js        html`` (escapes everything) and raw()
src/templates.js   the core templates, DEFAULT_COPY, the theme CSS
src/plugins/       formsPlugin and its templates
src/modules/       forms (read-only FORM_DB), events (append-only log), health
src/views.js, workflows.js, approval.js, markdown.js, dates.js   formsPlugin's parts
src/patch.js       submission -> active: merge patches, diffs, the fixed fields
src/csp.js         the CSP, and its per-page script hashes
db/migrations/     ADMIN_DB. Shipped: consumers point migrations_dir here
test/              fake D1 over node:sqlite + fixtures. Tests only, never shipped
releases.yaml      version history, newest first. NOT a golang project: tags have no "v"
```

## Rules

- **Site-agnostic.** No site's name, colour, domain or address in this repo. Examples
  use `example.org`.
- **Every HTML string through `html```.** `raw()` only for markup we wrote. The pages
  show what the public typed: one missed escape is stored XSS with admin access.
- **A plugin only ever runs signed in.** Never add a public plugin route. The core's
  guarantees (Origin on POST, Fetch Metadata, admin cookies stripped from the request
  and from its Set-Cookie, forced no-store/nosniff/DENY) apply to every plugin
  response; do not add a way around them.
- **Sign-in leaks nothing.** A non-allowlisted address gets the identical response,
  cookie and database work (rate limits counted, a code made and hashed). The email
  code goes out in `ctx.waitUntil`, never before the response. The push code is
  awaited and a failure shown: by then the address is proven.
- **The second factor is ONE flag**, `requireSecondFactor`. Its code lives only inside
  `if (secondFactor) {}` blocks (auth.js `verifyCode`, handler.js). A new channel
  replaces those blocks, nothing else.
- **Rate limits are keyed by a hash of the address**, never the address. No IP address
  is stored anywhere.
- **Codes and session tokens are stored only as SHA-256 hashes.**
- **FORM_DB is read-only**: all its SQL through `select()` in `src/modules/forms.js`.
  Every forms query is same-origin filtered on `url`; never drop that. Never migrate it.
- **A workflow changes nothing.** Its only output is ONE event, checked by
  `checkEvent` and appended to `workflow_events`. Append-only: never an UPDATE or
  DELETE there; a schema change is a new migration.
- **Submission and active** (`src/patch.js`). The submission is immutable. An
  event's optional `patch` (RFC 7396) amends what the record IS in the admin, never
  the row: `withEvents` returns the active record, every patch applied, with
  `submission` frozen. Every page and every workflow reads records through
  `withEvents`. `id` and `workflow` are never patchable. Queries (which rows) stay
  on the submission.
- **Scripts only by hash.** A workflow page's `scripts` are inlined and allowed by
  their sha256 in that response's CSP (`src/csp.js`). No `'unsafe-inline'`, no CDN,
  no script route.
- **Migrations are append-only too.** Never edit what a shipped migration does; a new
  column is a new file.
- **Security fixes need a test** that fails without them.

## Releasing

1. `npm test`.
2. Bump `version` in `package.json`; add a top entry to `releases.yaml` (quote the note).
3. Commit, tag `X.Y.Z` (no `v`), push the tag.
4. Consumers bump `"@mrmxf/cf-admin-tool": "github:mrmxf/cf-admin-tool#X.Y.Z"` and
   run `npm install`. A breaking change says so in its note, with what to edit.

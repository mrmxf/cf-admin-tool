//  Copyright ©2017-2026  Mr MXF   info@mrmxf.com
//  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
/**
 * cf-admin-tool — the public entry point.
 *
 * A Worker needs `createAdmin` and its plugins:
 *
 *   import { createAdmin, formsPlugin } from "@mrmxf/cf-admin-tool";
 *
 * `html` and `raw` are for templates and plugins; the patch helpers are for
 * workflows that edit a record (src/patch.js); the rest is exported for tests.
 */
export { createAdmin, normaliseRoot, normalisePlugins } from "./src/handler.js";
export { formsPlugin } from "./src/plugins/forms.js";
export { html, raw, esc } from "./src/html.js";
export { DEFAULT_TEMPLATES, DEFAULT_COPY } from "./src/templates.js";
export { FORMS_TEMPLATES } from "./src/plugins/forms-templates.js";
export { parseUsers } from "./src/auth.js";
export { approvalWorkflow } from "./src/approval.js";
export { renderMarkdown, fill } from "./src/markdown.js";
export { dateFormatters } from "./src/dates.js";
export { FIXED, mergePatch, diffPatch, changes, editable, checkPatch, isObject } from "./src/patch.js";
export { scriptHash } from "./src/csp.js";

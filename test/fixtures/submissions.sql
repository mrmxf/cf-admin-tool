-- TEST FIXTURE: cf-form-mailer's submissions table, schema_version 1, copied from
-- its db/migrations/0001_submissions.sql so these tests need no engine install.
-- The engine owns the real table; this tool never migrates it.
CREATE TABLE submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT, -- insertion order; internal, never exposed
  uid            TEXT NOT NULL UNIQUE,              -- crypto.randomUUID(); the public id
  form           TEXT NOT NULL,                     -- form.id, e.g. "parking"
  url            TEXT NOT NULL,                     -- the URL that was POSTed to
  timestamp      TEXT NOT NULL,                     -- Date.toISOString(): UTC, sorts as text
  schema_version INTEGER NOT NULL,                  -- the layout of THIS row
  outcome        TEXT NOT NULL,                     -- sent | send-failed | invalid | turnstile | honeypot
  form_meta      TEXT NOT NULL CHECK (json_valid(form_meta)), -- {id, version, engine, fields}
  answers        TEXT NOT NULL CHECK (json_valid(answers)),   -- field values; {} unless sent/send-failed
  session        TEXT NOT NULL CHECK (json_valid(session)),   -- browser + anti-spam signals
  workflow       TEXT NOT NULL CHECK (json_valid(workflow))   -- {"events":[{event,timestamp,status,statusMessage}]}
);
CREATE INDEX submissions_form_id      ON submissions (form, id);
CREATE INDEX submissions_form_outcome ON submissions (form, outcome, id);

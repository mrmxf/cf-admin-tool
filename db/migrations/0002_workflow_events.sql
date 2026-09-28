--  Copyright (c)2017-2026  Mr MXF   info@mrmxf.com
--  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
--
-- The workflow log. APPEND-ONLY: a row is never updated or deleted. A workflow
-- does nothing to a submission; all it can do is produce one event, which the
-- tool checks and appends here. Readers take the latest event per workflow.
--
-- In the ADMIN database because the submission log (FORM_DB) belongs to
-- cf-form-mailer and is read-only from the admin Worker. A record's events are
-- its own `workflow.events` (the engine's "submit") followed by these.
--
-- `origin` keeps staging and live apart, as every forms query does.
CREATE TABLE workflow_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT, -- append order: the latest wins
  origin         TEXT NOT NULL,                     -- e.g. https://www.example.org
  form           TEXT NOT NULL,                     -- form id, e.g. "parking"
  uid            TEXT NOT NULL,                     -- the submission's public id
  event          TEXT NOT NULL,                     -- "<workflow id>[-<decorator>]"
  timestamp      TEXT NOT NULL,                     -- ISO: when the workflow was started
  duration       INTEGER NOT NULL,                  -- whole ms, rounded up
  status         INTEGER NOT NULL,                  -- an HTTP status code, 100-599
  status_message TEXT NOT NULL,                     -- the short phrase the tables show
  actor          TEXT NOT NULL,                     -- the signed-in admin who ran it
  created_at     INTEGER NOT NULL                   -- Unix seconds, when appended
);
CREATE INDEX workflow_events_uid ON workflow_events (uid, id);

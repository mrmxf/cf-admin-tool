--  Copyright (c)2017-2026  Mr MXF   info@mrmxf.com
--  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
--
-- Settings an admin can change, e.g. a limit. APPEND-ONLY like the workflow
-- log: a change is a new row, never an UPDATE; the latest row per key is the
-- value. So every change keeps who made it, when and why.
--
-- `origin` keeps staging and live apart, as every other query does.
CREATE TABLE settings_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- append order: the latest wins
  origin     TEXT NOT NULL,                     -- e.g. https://www.example.org
  key        TEXT NOT NULL,                     -- e.g. "parking.max"
  value      TEXT NOT NULL,                     -- as typed, after the consumer's checks
  details    TEXT NOT NULL DEFAULT '',          -- why it was changed
  actor      TEXT NOT NULL,                     -- the signed-in admin who changed it
  created_at INTEGER NOT NULL                   -- Unix seconds
);
CREATE INDEX settings_events_key ON settings_events (origin, key, id);

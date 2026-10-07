--  Copyright (c)2017-2026  Mr MXF   info@mrmxf.com
--  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
--
-- An event's optional `patch`: an RFC 7396 JSON Merge Patch over the record
-- (src/patch.js). The submission in FORM_DB is never written; the admin reads
-- the ACTIVE record, the submission with every patch applied in append order.
-- "" for an event that changes nothing, which is every event but an edit.
ALTER TABLE workflow_events ADD COLUMN patch TEXT NOT NULL DEFAULT '';

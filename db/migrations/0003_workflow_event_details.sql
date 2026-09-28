--  Copyright (c)2017-2026  Mr MXF   info@mrmxf.com
--  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
--
-- An event's optional `details`: why it ended as it did, e.g. the reason a
-- send failed. "" when the workflow gave none.
ALTER TABLE workflow_events ADD COLUMN details TEXT NOT NULL DEFAULT '';

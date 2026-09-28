--  Copyright (c)2017-2026  Mr MXF   info@mrmxf.com
--  BSD-3-Clause License           https://opensource.org/license/bsd-3-clause/
--
-- Login state for the admin area. This is the ADMIN database (binding ADMIN_DB),
-- never the forms' submission log: the admin Worker only ever reads that one.
--
-- Never an IP address, in any column. Codes and session tokens are stored only
-- as SHA-256 hashes; a copy of this table cannot be used to log in.
--
-- Times are integer Unix seconds.

-- One row per login attempt, from "email entered" to "session issued".
-- A challenge exists for EVERY email typed in, allowlisted or not, so the
-- response cannot tell anyone which addresses are on the list. A challenge for
-- an address not on the list has an empty code hash and can never verify.
CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,      -- random, the value of the challenge cookie
  email      TEXT NOT NULL,         -- normalised (trimmed, lowercased)
  stage      TEXT NOT NULL,         -- email | ntfy
  code_hash  TEXT NOT NULL,         -- sha256(id ":" stage ":" code); "" = cannot verify
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expires ON challenges (expires_at);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,      -- sha256 of the cookie value
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- absolute limit
  last_seen  INTEGER NOT NULL       -- idle limit is measured from here
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Fixed-window counters, e.g. codes sent per email address.
CREATE TABLE rate (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

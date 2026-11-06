-- The sign-in log: one row per step of a sign-in attempt, shown at <root>/logins.
-- Append-only, except that rows older than 90 days are deleted (auth.js startLogin,
-- with the other housekeeping): it holds masked addresses of strangers.
CREATE TABLE auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- append order
  origin     TEXT NOT NULL,                     -- e.g. https://www.example.org
  attempt    TEXT NOT NULL,                     -- sha256 of the challenge id: groups one attempt.
                                                -- Never the id itself, which is a live cookie
  who        TEXT NOT NULL,                     -- the address if on the allowlist, else masked
  step       TEXT NOT NULL,                     -- e.g. "code-requested", "signed-in" (modules/logins.js)
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL                   -- Unix seconds
);
CREATE INDEX auth_events_attempt ON auth_events (origin, attempt, id);

-- Which attempt a session came from, so signing out joins its attempt in the log.
ALTER TABLE sessions ADD COLUMN attempt TEXT NOT NULL DEFAULT '';

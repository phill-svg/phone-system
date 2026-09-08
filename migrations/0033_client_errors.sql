-- migrations/0033_client_errors.sql
-- Crashes and uncaught errors reported by the mobile app.
--
-- The app had no error reporting of any kind, so when it started crash-looping on 2026-09-07 there
-- was nothing to read: TestFlight crash logs need an App Store Connect API key that isn't set, and
-- Play's Developer Reporting API is disabled on the project. The only recourse was rolling the OTA
-- back and guessing. This table is so that never happens twice.
--
-- Reports arrive in batches, because a fatal error kills the app before an HTTP request can finish.
-- The app queues them on device and sends on the NEXT launch, so `occurred_at` (when it broke) and
-- `received_at` (when we heard about it) are deliberately separate columns -- a gap between them is
-- itself the evidence that the error was fatal enough to take the app down.
CREATE TABLE client_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_email TEXT,
  platform    TEXT NOT NULL,
  ota_build   TEXT,
  app_version TEXT,
  -- 1 = the app went down. Non-fatal reports are caught by the error boundary, which keeps the app
  -- alive on a "something went wrong" screen; both are worth having.
  fatal       INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  message     TEXT NOT NULL,
  stack       TEXT,
  -- The route that was on screen. A stack trace off a minified bundle is often unreadable; the
  -- screen name usually isn't, and on its own it narrows the search to one file.
  screen      TEXT,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

-- Every read is "most recent first", which is the only way anyone looks at a crash log.
CREATE INDEX idx_client_errors_recent ON client_errors(occurred_at DESC);

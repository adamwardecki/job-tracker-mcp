// Shared by tests in more than one file.

// Turns a current database into one from the release before event sources (schema v5): drops what migration 6 added.
export const REWIND_TO_V5 = `
  DROP INDEX events_external;
  ALTER TABLE events DROP COLUMN source;
  ALTER TABLE events DROP COLUMN source_account;
  ALTER TABLE events DROP COLUMN source_id;
  ALTER TABLE events DROP COLUMN received_at;
  PRAGMA user_version = 5;
`;

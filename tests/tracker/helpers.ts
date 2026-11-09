// Shared by tests in more than one file.

// Turns a current database into the release before the asked salary (schema v9).
export const REWIND_TO_V9 = `
  ALTER TABLE roles DROP COLUMN asked_salary;
  PRAGMA user_version = 9;
`;

// Turns a current database into the release before accepted interview snapshots (schema v8).
export const REWIND_TO_V8 = `
  ${REWIND_TO_V9}
  DROP TABLE interview_external_state;
  PRAGMA user_version = 8;
`;

// Turns a current database into one from the release before interview states (schema v7): drops what migration 8 added.
export const REWIND_TO_V7 = `
  ${REWIND_TO_V8}
  DROP TABLE interview_changes;
  DROP INDEX interviews_external;
  ALTER TABLE interviews DROP COLUMN state;
  ALTER TABLE interviews DROP COLUMN updated_at;
  ALTER TABLE interviews DROP COLUMN source;
  ALTER TABLE interviews DROP COLUMN source_account;
  ALTER TABLE interviews DROP COLUMN source_id;
  ALTER TABLE interviews DROP COLUMN last_occurred_at;
  PRAGMA user_version = 7;
`;

// ...one from the release before source checkpoints (schema v6): drops what migration 7 added.
export const REWIND_TO_V6 = `
  ${REWIND_TO_V7}
  DROP TABLE source_checkpoints;
  PRAGMA user_version = 6;
`;

// ...and one from the release before event sources (schema v5): also drops what migration 6 added.
export const REWIND_TO_V5 = `
  ${REWIND_TO_V6}
  DROP INDEX events_external;
  ALTER TABLE events DROP COLUMN source;
  ALTER TABLE events DROP COLUMN source_account;
  ALTER TABLE events DROP COLUMN source_id;
  ALTER TABLE events DROP COLUMN received_at;
  PRAGMA user_version = 5;
`;

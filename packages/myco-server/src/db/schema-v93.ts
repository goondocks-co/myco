/** Each transcript keeps the record identity derivation assigned at registration. */
export const V93_STATEMENTS: readonly string[] = [
  `ALTER TABLE transcripts ADD COLUMN record_identity_scheme TEXT NOT NULL DEFAULT 'legacy-session-v1'`,
  `CREATE TRIGGER IF NOT EXISTS transcripts_record_identity_scheme_immutable BEFORE UPDATE OF record_identity_scheme ON transcripts
     WHEN NEW.record_identity_scheme IS NOT OLD.record_identity_scheme
     BEGIN SELECT RAISE(ABORT, 'record_identity_scheme_immutable'); END`,
];

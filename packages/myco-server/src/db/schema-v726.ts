import { reaching, type Reach, changing } from './schema-step.js';
/**
 * One unresolved naming failure per member, and the Attention mark that moves with every change to them.
 *
 * Triggers carry both lifecycles, so every writer of a member's name or revocation clears the row in its own commit,
 * and every change to the rows moves the mark in that same commit. The rows are transient evidence, left out of backups.
 */
export const V726 = 726;

export const V726_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS member_naming_failures(
    member_id TEXT PRIMARY KEY,
    error_class TEXT NOT NULL CHECK (length(error_class) BETWEEN 1 AND 64),
    failures INTEGER NOT NULL CHECK (failures >= 1),
    last_failed_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_member_naming_failures_recent ON member_naming_failures(last_failed_at DESC, member_id)`,
  `INSERT OR IGNORE INTO change_marks(kind,revision) VALUES('attention',0)`,
  `CREATE TRIGGER IF NOT EXISTS member_naming_failure_resolved AFTER UPDATE OF label,revoked_at ON members
    WHEN ((NEW.label IS NOT NULL AND OLD.label IS NOT NEW.label) OR NEW.revoked_at IS NOT NULL)
      AND EXISTS(SELECT 1 FROM member_naming_failures WHERE member_id=NEW.id)
    BEGIN DELETE FROM member_naming_failures WHERE member_id=NEW.id; END`,
  `CREATE TRIGGER IF NOT EXISTS member_naming_failure_removed AFTER DELETE ON members
    WHEN EXISTS(SELECT 1 FROM member_naming_failures WHERE member_id=OLD.id)
    BEGIN DELETE FROM member_naming_failures WHERE member_id=OLD.id; END`,
  ...['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER IF NOT EXISTS change_mark_attention_naming_${action.toLowerCase()} AFTER ${action} ON member_naming_failures
    BEGIN UPDATE change_marks SET revision=revision+1 WHERE kind='attention'; END`),
];

/** Why the step reaches tables earlier steps created. */
export const V726_REACHES: readonly Reach[] = [
  ...changing(['change_marks'], 'The Attention revision exists before its first transition, so an open page has a value to compare.'),
  ...reaching(['members'], 'A naming failure ends in the commit that names, revokes or removes its member.'),
];

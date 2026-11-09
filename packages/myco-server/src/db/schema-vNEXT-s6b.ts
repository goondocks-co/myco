/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S6B = 752;

/**
 * Authority retention, the link redemption receipt, the active Project counter, and the last retired authority table.
 *
 * An authority's `reclaim_at` is empty until the shared catch-up has derived it, so nothing can reclaim a row whose
 * deadline is not known yet. Each index build has its own transaction.
 */
export const VNEXT_S6B_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S6B, statements: ['ALTER TABLE enrollment_authorities ADD COLUMN reclaim_at INTEGER'] },
  { version: NEXT_S6B + 1, statements: ['ALTER TABLE identity_link_authorities ADD COLUMN reclaim_at INTEGER'] },
  { version: NEXT_S6B + 2, statements: ['CREATE INDEX IF NOT EXISTS idx_enrollment_authorities_reclaim ON enrollment_authorities(reclaim_at,id)'] },
  { version: NEXT_S6B + 3, statements: ['CREATE INDEX IF NOT EXISTS idx_identity_link_authorities_reclaim ON identity_link_authorities(reclaim_at,id)'] },
  { version: NEXT_S6B + 4, statements: [
    "CREATE TRIGGER IF NOT EXISTS enrollment_authorities_reclaim_insert AFTER INSERT ON enrollment_authorities BEGIN UPDATE enrollment_authorities SET reclaim_at=(CASE WHEN NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL\n  THEN MIN(COALESCE(NEW.used_at,NEW.revoked_at),COALESCE(NEW.revoked_at,NEW.used_at))\n  ELSE NEW.expires_at END+2592000000) WHERE id=NEW.id; END",
    "CREATE TRIGGER IF NOT EXISTS enrollment_authorities_reclaim_update AFTER UPDATE OF used_at,revoked_at,expires_at ON enrollment_authorities WHEN OLD.used_at IS NOT NEW.used_at OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.expires_at IS NOT NEW.expires_at BEGIN UPDATE enrollment_authorities SET reclaim_at=(CASE WHEN NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL\n  THEN MIN(COALESCE(NEW.used_at,NEW.revoked_at),COALESCE(NEW.revoked_at,NEW.used_at))\n  ELSE NEW.expires_at END+2592000000) WHERE id=NEW.id; END",
    "CREATE TRIGGER IF NOT EXISTS identity_link_authorities_reclaim_insert AFTER INSERT ON identity_link_authorities BEGIN UPDATE identity_link_authorities SET reclaim_at=(CASE WHEN NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL\n  THEN MIN(COALESCE(NEW.used_at,NEW.revoked_at),COALESCE(NEW.revoked_at,NEW.used_at))\n  ELSE NEW.expires_at END+604800000) WHERE id=NEW.id; END",
    "CREATE TRIGGER IF NOT EXISTS identity_link_authorities_reclaim_update AFTER UPDATE OF used_at,revoked_at,expires_at ON identity_link_authorities WHEN OLD.used_at IS NOT NEW.used_at OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.expires_at IS NOT NEW.expires_at BEGIN UPDATE identity_link_authorities SET reclaim_at=(CASE WHEN NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL\n  THEN MIN(COALESCE(NEW.used_at,NEW.revoked_at),COALESCE(NEW.revoked_at,NEW.used_at))\n  ELSE NEW.expires_at END+604800000) WHERE id=NEW.id; END",
    "INSERT INTO projection_catchup(projection,phase,done) SELECT 'authority_retention','enrollmentAuthorityDeadlines',\n      NOT EXISTS(SELECT 1 FROM enrollment_authorities WHERE reclaim_at IS NULL) ON CONFLICT DO NOTHING",
    "INSERT INTO projection_catchup(projection,phase,done) SELECT 'authority_retention','identityLinkDeadlines',\n      NOT EXISTS(SELECT 1 FROM identity_link_authorities WHERE reclaim_at IS NULL) ON CONFLICT DO NOTHING",
  ] },
  { version: NEXT_S6B + 5, statements: [
    `CREATE TABLE IF NOT EXISTS identity_link_redemptions(
      key_hash TEXT PRIMARY KEY,github_id TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('bound','identity_taken','member_linked','member_revoked','link_requires_admin')),
      member_id TEXT,decided_at INTEGER NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_identity_link_redemptions_decided ON identity_link_redemptions(decided_at,key_hash)',
  ] },
  { version: NEXT_S6B + 6, statements: [
    'CREATE TABLE IF NOT EXISTS active_project_count(slot INTEGER PRIMARY KEY CHECK(slot=1),active INTEGER NOT NULL)',
    'INSERT INTO active_project_count(slot,active) SELECT 1,COUNT(*) FROM projects WHERE archived_at IS NULL ON CONFLICT DO NOTHING',
    'CREATE TRIGGER IF NOT EXISTS active_project_count_insert AFTER INSERT ON projects WHEN NEW.archived_at IS NULL BEGIN UPDATE active_project_count SET active=active+1 WHERE slot=1; END',
    'CREATE TRIGGER IF NOT EXISTS active_project_count_delete AFTER DELETE ON projects WHEN OLD.archived_at IS NULL BEGIN UPDATE active_project_count SET active=active-1 WHERE slot=1; END',
    'CREATE TRIGGER IF NOT EXISTS active_project_count_archive AFTER UPDATE OF archived_at ON projects WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL BEGIN UPDATE active_project_count SET active=active-1 WHERE slot=1; END',
    'CREATE TRIGGER IF NOT EXISTS active_project_count_unarchive AFTER UPDATE OF archived_at ON projects WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL BEGIN UPDATE active_project_count SET active=active+1 WHERE slot=1; END',
  ] },
  { version: NEXT_S6B + 7, statements: ['DROP TABLE IF EXISTS step_up_authorities'] },
];

export const LATEST_S6B = NEXT_S6B + VNEXT_S6B_STEPS.length - 1;

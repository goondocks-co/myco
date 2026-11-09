import { HARNESS_MEMBER_ID } from '../../constants.js';
import { read, write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';

const LINEAGE_HEAD_PROJECTION = 'credential_lineages';
const LINEAGE_HEAD_PHASE = 'credentialLineages';

/** Run credentials are one-row lineages owned by their run, so only a member's own runtimes have a head. */
const PERSON_CREDENTIAL = (alias: string) => `${alias}.member_id<>'${HARNESS_MEMBER_ID}'`;

const LINEAGE_HEAD_SOURCE = {
  table: 'member_credentials INDEXED BY idx_member_credentials_person_lineage',
  columns: ['lineage_root'],
  where: `member_id<>'${HARNESS_MEMBER_ID}'`,
};

const LIVE = (root: string, condition = '1') => `FROM member_credentials c INDEXED BY idx_member_credentials_live_lineage
  WHERE c.lineage_root=${root} AND c.revoked_at IS NULL AND ${condition}`;
const ACTIVATED = '(c.predecessor_id IS NULL OR c.first_used_at IS NOT NULL)';
const BANKED = 'c.predecessor_id IS NOT NULL AND c.first_used_at IS NULL';
const NEWEST = 'ORDER BY c.issued_at DESC,c.id DESC LIMIT 1';
const HEAD_COLUMNS = ['member_id', 'machine_id', 'started_at', 'current_id', 'banked_id', 'live_tokens', 'banked_tokens', 'live_until'];

/**
 * One head per lineage named by `keys` (a subquery yielding `lineage_root`), re-derived from the lineage's unrevoked
 * rows, so its cost follows the live rows of the lineage and never its rotation history.
 */
const reconcileHead = (keys: string): string => `INSERT INTO credential_lineages(lineage_root,${HEAD_COLUMNS.join(',')})
  SELECT a.lineage_root,a.member_id,a.machine_id,a.lineage_started_at,
    (SELECT c.id ${LIVE('a.lineage_root', ACTIVATED)} ${NEWEST}),
    (SELECT c.id ${LIVE('a.lineage_root', BANKED)} ${NEWEST}),
    (SELECT COUNT(*) ${LIVE('a.lineage_root')}),
    (SELECT COUNT(*) ${LIVE('a.lineage_root', BANKED)}),
    COALESCE((SELECT MAX(c.expires_at) ${LIVE('a.lineage_root')}),0)
  FROM (${keys}) k CROSS JOIN member_credentials a ON a.id=(SELECT f.id FROM member_credentials f INDEXED BY idx_member_credentials_person_lineage WHERE f.lineage_root=k.lineage_root AND ${PERSON_CREDENTIAL('f')} LIMIT 1)
  WHERE ${PERSON_CREDENTIAL('a')}
  ON CONFLICT(lineage_root) DO UPDATE SET ${HEAD_COLUMNS.map(column => `${column}=excluded.${column}`).join(',')}
  WHERE (${HEAD_COLUMNS.map(column => `credential_lineages.${column}`).join(',')}) IS NOT (${HEAD_COLUMNS.map(column => `excluded.${column}`).join(',')})`;

const removeEmptyHead = (root: string): string => `DELETE FROM credential_lineages WHERE lineage_root=${root}
  AND NOT EXISTS (SELECT 1 FROM member_credentials f INDEXED BY idx_member_credentials_person_lineage WHERE f.lineage_root=credential_lineages.lineage_root AND ${PERSON_CREDENTIAL('f')})`;

/** The shared catch-up replays exactly the reconcile the triggers run. */
const LINEAGE_HEAD_RECONCILE = [write<[keys: string]>({
  name: 'lineageHeads.reconcilePage',
  sql: reconcileHead(`SELECT json_extract(value,'$[0]') AS lineage_root FROM json_each(?1)`),
})];

/** Whether every existing lineage has its head; a phase that is absent or unfinished means `building`. */
export const lineageHeadsReady = read<[], { done: number }>({
  name: 'lineageHeads.ready',
  sql: `SELECT done FROM projection_catchup WHERE projection='${LINEAGE_HEAD_PROJECTION}' AND phase='${LINEAGE_HEAD_PHASE}'`,
});

/** A restore replaces the credentials wholesale, and the rebuild starts from no heads. */
const clearLineageHeads = write<[]>({ name: 'lineageHeads.clear', sql: 'DELETE FROM credential_lineages' });

/** Replaying every lineage rebuilds its head, so heads a copy brought with it cannot survive a restart. */
export const LINEAGE_HEAD_CATCHUP = {
  projection: LINEAGE_HEAD_PROJECTION,
  reset: () => [clearLineageHeads.bind()],
  phases: { [LINEAGE_HEAD_PHASE]: { source: LINEAGE_HEAD_SOURCE, reconcile: LINEAGE_HEAD_RECONCILE } },
} as const satisfies CatchupFamily;

/** The step's frozen text: the heads, their triggers and the catch-up phase. Pinned to the step so the triggers keep the reconcile the catch-up runs. */
export function lineageHeadSchemaStatements(): string[] {
  const root = (row: 'NEW' | 'OLD') => `(SELECT ${row}.lineage_root AS lineage_root)`;
  return [
    `CREATE TABLE IF NOT EXISTS credential_lineages(lineage_root TEXT PRIMARY KEY,member_id TEXT NOT NULL,machine_id TEXT,started_at INTEGER NOT NULL,
      current_id TEXT,banked_id TEXT,live_tokens INTEGER NOT NULL,banked_tokens INTEGER NOT NULL,live_until INTEGER NOT NULL) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS idx_credential_lineages_member_live ON credential_lineages(member_id,live_until) WHERE live_tokens>0`,
    `CREATE INDEX IF NOT EXISTS idx_members_created ON members(created_at,id)`,
    `CREATE INDEX IF NOT EXISTS idx_enrollment_authorities_open ON enrollment_authorities(created_at,id) WHERE used_at IS NULL AND revoked_at IS NULL`,
    `CREATE TRIGGER IF NOT EXISTS credential_lineages_insert AFTER INSERT ON member_credentials WHEN ${PERSON_CREDENTIAL('NEW')}
      BEGIN ${reconcileHead(`SELECT NEW.lineage_root AS lineage_root`)}; END`,
    `CREATE TRIGGER IF NOT EXISTS credential_lineages_update AFTER UPDATE OF revoked_at,first_used_at,expires_at ON member_credentials
      WHEN ${PERSON_CREDENTIAL('NEW')} AND (OLD.revoked_at,OLD.first_used_at,OLD.expires_at) IS NOT (NEW.revoked_at,NEW.first_used_at,NEW.expires_at)
      BEGIN ${reconcileHead(`SELECT NEW.lineage_root AS lineage_root`)}; END`,
    `CREATE TRIGGER IF NOT EXISTS credential_lineages_delete AFTER DELETE ON member_credentials WHEN ${PERSON_CREDENTIAL('OLD')}
      BEGIN ${reconcileHead(`SELECT OLD.lineage_root AS lineage_root`)}; ${removeEmptyHead('OLD.lineage_root')}; END`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${LINEAGE_HEAD_PROJECTION}','${LINEAGE_HEAD_PHASE}',
      NOT EXISTS(SELECT 1 FROM member_credentials INDEXED BY idx_member_credentials_person_lineage WHERE ${LINEAGE_HEAD_SOURCE.where}) ON CONFLICT DO NOTHING`,
  ];
}

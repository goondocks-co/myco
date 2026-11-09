import { archiveRawSources } from '../core/raw-archive.js';
import { measuredContentEnv, remainingContentBudget } from '../core/content-budget.js';
/**
 * Raw retention archives eligible event bodies and parsed transcript segments
 * before clearing hot rows. The orphan audit releases aged objects only after
 * the shared reference catalogue proves that no surviving row names them.
 */
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { auditBlobOrphans } from '../db/storage/blob-orphan-audit.js';
import { storedSettings } from '../core/settings.js';
import { emit } from '../telemetry.js';

/** The legacy raw age leaf. */
const TRANSCRIPT_RETENTION_LEAF = 'retention.transcripts';

/**
 * The effective raw age policy: a canonical leaf wins, a finite legacy leaf is
 * honored, and an explicit legacy zero holds archival. Without either leaf,
 * the 90-day default applies. Unreadable settings hold archival visibly.
 */
type RetentionFact =
  | { state: 'forever'; configured: boolean; compatibility: 'legacy-hold' }
  | { state: 'days'; days: number; configured: boolean; compatibility: 'canonical'|'legacy-finite'|'default' }
  | { state: 'unavailable'; reason: string };

const RAW_RETENTION_LEAF = 'retention.raw_days';
const RAW_RETENTION_DEFAULT_DAYS = 90;

/** Canonical raw age policy; an explicit legacy forever choice holds archival until a finite choice is made. */
export async function transcriptRetentionFact(db: RelationalStore): Promise<RetentionFact> {
  const held = await storedSettings(db, [RAW_RETENTION_LEAF, TRANSCRIPT_RETENTION_LEAF]);
  const canonical = held.get(RAW_RETENTION_LEAF);
  if (canonical !== undefined) return canonical.violation === null
    ? { state:'days',days:canonical.value as number,configured:true,compatibility:'canonical' }
    : { state:'unavailable',reason:'The raw retention window does not read; archival is held.' };
  const legacy = held.get(TRANSCRIPT_RETENTION_LEAF);
  if (legacy === undefined) return { state:'days',days:RAW_RETENTION_DEFAULT_DAYS,configured:false,compatibility:'default' };
  if (legacy.violation !== null) return { state:'unavailable',reason:'The legacy raw window does not read; archival is held.' };
  return legacy.value === 0 ? { state:'forever',configured:true,compatibility:'legacy-hold' }
    : { state:'days',days:legacy.value as number,configured:true,compatibility:'legacy-finite' };
}

/**
 * Runs one bounded orphan page and one bounded raw archive page under the
 * effective age policy. Derived rows and unread transcript bytes remain held.
 */
export async function transcriptRetention(env: ServerEnv, now: number): Promise<number> {
  const measured = measuredContentEnv(env, remainingContentBudget(env.db));
  const orphans = await freeOrphanedBlobs(measured.env,now);
  const fact = await transcriptRetentionFact(measured.env.db);
  if(fact.state==='unavailable') { emit({kind:'transcript_retention_refused',reason:'refused'});return orphans; }
  if(fact.state==='forever') return orphans;
  return orphans + await archiveRawSources(measured.env,now,fact.days);
}

/** Examines one page of registered blobs for what nothing references, and reports what the audit released. */
export async function freeOrphanedBlobs(env: Pick<ServerEnv, 'db'>, now: number): Promise<number> {
  const { released, deferred } = await auditBlobOrphans(env.db, now);
  if (released + deferred > 0) emit({ kind: 'orphaned_blobs_freed', blobs: released, deferred });
  return released;
}

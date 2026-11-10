import type { RelationalStore } from '../../core/adapters.js';
import type { CapturePoint, Cleanliness, ReleaseNamespace } from '../../core/provenance.js';
import { first, read, readSet, rows } from '../index.js';
import { CLEANLINESS_SQL } from './schema.js';

/** One record's release state as a reader gets it, with `propagating` set while the session state it follows is still being carried to it. */
export interface StoredReleaseState {
  id: string;
  namespace: string;
  recordId: string;
  state: string;
  confidence: string;
  basisKind: string | null;
  basisRef: string | null;
  basisSha: string | null;
  releasePrNumber: number | null;
  reason: string | null;
  checkedAt: number;
  propagating: 0 | 1;
}

/**
 * The stored forms of a namespace, the table name first. The canonicalization catch-up rewrites older writers' singular
 * rows; until it has reached a row, a read still matches it, so no record reads as having no state while the catch-up runs.
 */
const STORED_FORMS: Readonly<Record<ReleaseNamespace, readonly [string, string]>> = {
  spore: ['spores', 'spore'],
  session: ['sessions', 'session'],
  plan: ['plans', 'plan'],
};

const STATE_COLUMNS = `id,namespace,record_id AS recordId,state,confidence,basis_kind AS basisKind,basis_ref AS basisRef,basis_sha AS basisSha,
  release_pr_number AS releasePrNumber,reason,checked_at AS checkedAt,
  (namespace<>'sessions' AND namespace<>'session' AND EXISTS (SELECT 1 FROM release_propagation_due q WHERE q.project_id=k.project_id AND q.session_id=k.source_session_id)) AS propagating`;

const oneState = read<[project: string, namespace: string, singular: string, record: string], StoredReleaseState & { source: string | null }>({ name: 'releaseState.one', sql:
  `SELECT ${STATE_COLUMNS},COALESCE(k.source_key,CASE WHEN json_valid(k.evidence_json) THEN json_extract(k.evidence_json,'$.source') END) AS source
   FROM knowledge_release_state k INDEXED BY idx_knowledge_release_embedding WHERE k.project_id=?1 AND k.namespace IN (?2,?3) AND k.record_id=?4 ORDER BY k.checked_at DESC,k.id DESC LIMIT 1` });

const manyStates = read<[project: string, namespace: string, singular: string, records: string], StoredReleaseState>({ name: 'releaseState.many', sql:
  `SELECT ${STATE_COLUMNS} FROM knowledge_release_state k INDEXED BY idx_knowledge_release_embedding
   WHERE k.project_id=?1 AND k.namespace IN (?2,?3) AND k.record_id IN (SELECT value FROM json_each(?4)) ORDER BY k.checked_at ASC,k.id ASC` });

export const readReleaseState = (db: RelationalStore, project: string, namespace: ReleaseNamespace, record: string) =>
  first(db, oneState.bind(project, ...STORED_FORMS[namespace], record));

export const readReleaseStates = (db: RelationalStore, project: string, namespace: ReleaseNamespace, records: readonly string[]) =>
  rows(db, manyStates.bind(project, ...STORED_FORMS[namespace], JSON.stringify([...new Set(records)])));

export const readReleaseStatesAcross = (db: RelationalStore, wanted: ReadonlyArray<{ projectId: string; namespace: ReleaseNamespace; recordIds: readonly string[] }>) =>
  readSet(db, ...wanted.map(w => manyStates.bind(w.projectId, ...STORED_FORMS[w.namespace], JSON.stringify([...new Set(w.recordIds)]))));

const latestCheck = read<[project: string], { status: string | null; failure: string | null; finishedAt: number | null }>({ name: 'releaseState.latestCheck', sql:
  'SELECT check_status AS status,check_failure AS failure,check_finished_at AS finishedAt FROM project_release_provenance WHERE project_id=?1' });

export const readLatestCheck = (db: RelationalStore, project: string) => first(db, latestCheck.bind(project));

/** A session's commit observations, as `read/session-commits.ts` answers them. */
interface Observation { point: CapturePoint; headSha: string; branch: string | null; capturedAt: number; cleanliness: Cleanliness }
const observations = read<[project: string, session: string], Observation>({ name: 'releaseState.observations', sql:
  `SELECT g.capture_point AS point,g.head_sha AS headSha,g.branch,g.captured_at AS capturedAt,${CLEANLINESS_SQL} AS cleanliness
   FROM knowledge_git_provenance g WHERE g.project_id=?1 AND g.session_id=?2 AND g.capture_point IN ('session_start','session_end') AND g.head_sha IS NOT NULL` });

export const readSessionObservations = (db: RelationalStore, project: string, session: string) => rows(db, observations.bind(project, session));

/** How far one filtered list read walks; a walk that stops here says so with a continuation. */
export const RELEASE_LIST_SCAN = 1000;

const LIST_ROWS = `SELECT ${STATE_COLUMNS} FROM (SELECT * FROM knowledge_release_state WHERE project_id=?1 AND (checked_at,id)<(?2,?3) ORDER BY checked_at DESC,id DESC LIMIT ?4) k`;

const listAll = read<[project: string, beforeAt: number, beforeId: string, take: number], StoredReleaseState>({ name: 'releaseState.listAll', sql: `${LIST_ROWS} ORDER BY k.checked_at DESC,k.id DESC` });
const listFiltered = read<[project: string, beforeAt: number, beforeId: string, scan: number, namespace: string | null, singular: string | null, state: string | null, take: number], StoredReleaseState>({ name: 'releaseState.listFiltered', sql:
  `${LIST_ROWS} WHERE (?5 IS NULL OR k.namespace IN (?5,?6)) AND (?7 IS NULL OR k.state=?7) ORDER BY k.checked_at DESC,k.id DESC LIMIT ?8` });
const listWalked = read<[project: string, beforeAt: number, beforeId: string, scan: number], { checkedAt: number; id: string; walked: number }>({ name: 'releaseState.listWalked', sql:
  `SELECT checked_at AS checkedAt,id,COUNT(*) OVER () AS walked FROM (SELECT checked_at,id FROM knowledge_release_state WHERE project_id=?1 AND (checked_at,id)<(?2,?3) ORDER BY checked_at DESC,id DESC LIMIT ?4) ORDER BY checked_at ASC,id ASC LIMIT 1` });

interface ReleaseStatePage {
  states: StoredReleaseState[];
  /** The position after the last row looked at, or null when nothing follows; a filtered read may stop at its walk bound before a page fills. */
  next: { checkedAt: number; id: string } | null;
}

/** One page newest-checked first. `before` is exclusive; a filter walks at most `RELEASE_LIST_SCAN` rows per read. */
export async function readReleaseStatePage(db: RelationalStore, project: string, opts: { before: { checkedAt: number; id: string } | null; namespace?: ReleaseNamespace; state?: string; limit: number }): Promise<ReleaseStatePage> {
  const beforeAt = opts.before?.checkedAt ?? Number.MAX_SAFE_INTEGER;
  const beforeId = opts.before?.id ?? '￿';
  const filtered = opts.namespace !== undefined || opts.state !== undefined;
  const take = opts.limit + 1;
  if (!filtered) {
    const page = await rows(db, listAll.bind(project, beforeAt, beforeId, take));
    return { states: page.slice(0, opts.limit), next: page.length > opts.limit ? keyOf(page[opts.limit - 1]!) : null };
  }
  const [namespace, singular] = opts.namespace === undefined ? [null, null] : STORED_FORMS[opts.namespace];
  const [page, walked] = await readSet(db,
    listFiltered.bind(project, beforeAt, beforeId, RELEASE_LIST_SCAN, namespace, singular, opts.state ?? null, take),
    listWalked.bind(project, beforeAt, beforeId, RELEASE_LIST_SCAN));
  const states = page.slice(0, opts.limit);
  if (page.length > opts.limit) return { states, next: keyOf(states.at(-1)!) };
  const lastWalked = walked[0];
  return { states, next: lastWalked === undefined || lastWalked.walked < RELEASE_LIST_SCAN ? null : { checkedAt: lastWalked.checkedAt, id: lastWalked.id } };
}

const keyOf = (row: { checkedAt: number; id: string }) => ({ checkedAt: row.checkedAt, id: row.id });

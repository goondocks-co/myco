/**
 * Release state, read-side.
 *
 * The agent consumes release provenance to annotate what it reads; it does not
 * write it. Writes arrive through capture and through the reconciler job, so
 * only the reads a task needs live here.
 *
 * **The bulk lookup is one statement, not one per record.** Search hydration
 * annotates every result row, and a lookup per row is the N+1 that makes
 * annotation cost scale with the page. `json_each` carries the id set into a
 * single query, and the ids are de-duplicated first so a page repeating a
 * record does not widen it.
 *
 * **An unknown namespace is refused rather than queried.** A namespace that
 * matches nothing returns an empty answer indistinguishable from a record with
 * no release state, so a caller misspelling one would read "not released"
 * forever.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { readLatestCheck, readReleaseState, readReleaseStatePage, readReleaseStates, readReleaseStatesAcross, type StoredReleaseState } from '../db/release/states.js';

/** The namespaces a caller names. */
const RELEASE_NAMESPACES = ['spore', 'session', 'plan'] as const;
export type ReleaseNamespace = (typeof RELEASE_NAMESPACES)[number];

/** The forms a stored row or a caller may name a namespace by: the table name is canonical, and a read answers by the singular one. */
const NAMESPACE_FORMS: Readonly<Record<ReleaseNamespace, readonly [string, string]>> = {
  spore: ['spore', 'spores'],
  session: ['session', 'sessions'],
  plan: ['plan', 'plans'],
};

const PUBLIC_BY_STORED = new Map<string, ReleaseNamespace>(
  RELEASE_NAMESPACES.flatMap((n) => NAMESPACE_FORMS[n].map((form) => [form, n] as const)),
);

/** A namespace as a caller or a stored row names it, or null when it names none. */
export const canonicalNamespace = (value: unknown): ReleaseNamespace | null =>
  typeof value === 'string' ? PUBLIC_BY_STORED.get(value) ?? null : null;

export const isReleaseNamespace = (value: unknown): value is ReleaseNamespace =>
  typeof value === 'string' && (RELEASE_NAMESPACES as readonly string[]).includes(value);

/** Whether tracked files differed from the commit: `0`, `1`, or `unknown` when git could not say. */
export type Cleanliness = '0' | '1' | 'unknown';

/** Where in a session its member observes a commit. */
export type CapturePoint = 'session_start' | 'session_end';

/** A session's observed commit, as the release check classifies it. */
interface ReleaseSource { point: CapturePoint; headSha: string; cleanliness: Cleanliness }

/** The captured commit a release state is classified from, as `evidence_json.source` records it: a new one is classified afresh. */
export const sourceOf = (c: ReleaseSource) => `${c.point}:${c.headSha}:${c.cleanliness}`;

/** The capture point a recorded source names, or null when it names none. */
export const sourcePoint = (source: string): CapturePoint | null => {
  const point = source.slice(0, source.indexOf(':'));
  return point === 'session_start' || point === 'session_end' ? point : null;
};

interface ReleaseStateRow {
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
  /** The session state this record follows has changed and is still being carried to it, so `state` is what it last carried. */
  propagating: boolean;
}

/** One record's latest release state, with the captured commit it is classified from. */
interface ReleaseStateWithSource extends ReleaseStateRow {
  /** As `sourceOf` records it, or null for a state recorded without one. */
  source: string | null;
}

const named = (row: StoredReleaseState): ReleaseStateRow => ({ ...row, namespace: canonicalNamespace(row.namespace) ?? row.namespace, propagating: row.propagating === 1 });

export async function getReleaseState(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordId: string,
): Promise<ReleaseStateWithSource | null> {
  const row = await readReleaseState(db, scope.projectId, namespace, recordId);
  return row === null ? null : { ...named(row), source: row.source };
}

/**
 * Release state for many records in one query.
 *
 * A record with no release state is simply absent from the result, which is a
 * different answer from one whose state is unknown.
 */
export async function getReleaseStatesForRecords(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordIds: readonly string[],
): Promise<Record<string, ReleaseStateRow>> {
  if (recordIds.length === 0) return {};
  const states = await readReleaseStates(db, scope.projectId, namespace, recordIds);
  return Object.fromEntries(states.map((r) => [r.recordId, named(r)]));
}

/**
 * Release state for records of several Projects in one round trip: for each entry of `wanted`, the rows
 * `getReleaseStatesForRecords` answers for it, keyed by record id, in the order asked. The statements are the same
 * one, batched.
 */
export async function getReleaseStatesAcross(
  db: RelationalStore, wanted: ReadonlyArray<{ projectId: string; namespace: ReleaseNamespace; recordIds: readonly string[] }>,
): Promise<Array<Record<string, ReleaseStateRow>>> {
  if (wanted.length === 0) return [];
  const answers = await readReleaseStatesAcross(db, wanted);
  return wanted.map((_, i) => Object.fromEntries((answers[i] ?? []).map((r) => [r.recordId, named(r)])));
}

interface ReleaseStatesCursor { checkedAt: number; id: string; namespace: ReleaseNamespace | null; state: string | null }

/** The largest page a release-state list answers. */
const MAX_RELEASE_LIST = 200;

/** The list-position token: the full order tuple and the filter it continues, so a cursor never continues a different listing. */
const encodeReleaseStatesCursor = (cursor: ReleaseStatesCursor): string => btoa(JSON.stringify([1, cursor.namespace, cursor.state, cursor.checkedAt, cursor.id]));

/** Reads a cursor back, or null when it is not one this listing issued. */
export function decodeReleaseStatesCursor(token: string): ReleaseStatesCursor | null {
  try {
    const value = JSON.parse(atob(token)) as unknown;
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1) return null;
    const [, namespace, state, checkedAt, id] = value as [number, unknown, unknown, unknown, unknown];
    if (typeof checkedAt !== 'number' || typeof id !== 'string' || (namespace !== null && !isReleaseNamespace(namespace)) || (state !== null && typeof state !== 'string')) return null;
    return { checkedAt, id, namespace, state };
  } catch { return null; }
}

/** One page of a Project's release states, newest checked first, continuing a listing with `cursor`. */
export async function listReleaseStates(
  db: RelationalStore, scope: ReadScope, o: { namespace?: ReleaseNamespace; state?: string; limit?: number; cursor?: ReleaseStatesCursor | null } = {},
): Promise<{ states: ReleaseStateRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(o.limit ?? 100, MAX_RELEASE_LIST));
  const page = await readReleaseStatePage(db, scope.projectId, {
    before: o.cursor ? { checkedAt: o.cursor.checkedAt, id: o.cursor.id } : null, namespace: o.namespace, state: o.state, limit,
  });
  return {
    states: page.states.map(named),
    nextCursor: page.next === null ? null : encodeReleaseStatesCursor({ ...page.next, namespace: o.namespace ?? null, state: o.state ?? null }),
  };
}

/** A record's release state as every surface presents it: the state, its age, and whether the Project's latest check failed after it. */
interface ReleaseStatus {
  state: string;
  confidence: string;
  ref: string | null;
  reason: string | null;
  checkedAt: number;
  /** The Project's latest check, when it finished after this state's check without completing: the state shown is older than that attempt. */
  latestCheck: { status: string; failure: string | null; finishedAt: number } | null;
}

export async function getReleaseStatus(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordId: string,
): Promise<ReleaseStatus | null> {
  const row = await getReleaseState(db, scope, namespace, recordId);
  if (row === null) return null;
  const check = await readLatestCheck(db, scope.projectId);
  const failedAfter = check !== null && check.status !== null && check.status !== 'complete' && check.failure !== null
    && check.finishedAt !== null && check.finishedAt > row.checkedAt;
  return {
    state: row.state, confidence: row.confidence, ref: row.basisRef, reason: row.reason, checkedAt: row.checkedAt,
    latestCheck: failedAfter ? { status: check.status!, failure: check.failure, finishedAt: check.finishedAt! } : null,
  };
}

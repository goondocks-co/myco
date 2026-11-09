import type { RelationalStore } from '../../core/adapters.js';
import type { ResolutionAction, SporeInsert, SporeProvenance, SporeRow, SporeStatus } from '../../core/spores.js';
import type { ReadScope } from '../../read/scope.js';
import { assertion, commitNamed, refusalCode, refusalDetail, write } from '../index.js';
import { importAdmittedAssertion, importRefused, sporeInsertWrite } from './records.js';

/**
 * Moving a spore out of the active set: one resolution or one consolidation, each one commit.
 *
 * An assertion at the head of the batch decides the whole outcome inside the commit: every source still at its expected status and revision, the
 * successor valid, the caller entitled, the event id unused. When it refuses, nothing is written: no wisdom spore, no event, no source moved. Its detail
 * reports which condition failed against the rows the commit saw, so a refusal names the source to reread without a second read that could disagree.
 * Status moves run last in the commit.
 */

interface ResolutionEventInsert {
  channel?: 'import';
  id: string;
  agentId: string;
  sporeId: string;
  action: ResolutionAction;
  newSporeId: string | null;
  reason: string | null;
  sessionId: string | null;
  /** The principal instance that resolved it, as `SporeInsert.author`. */
  author: string | null;
  /** As `SporeInsert.provenance`. */
  provenance?: SporeProvenance | null;
  createdAt: number;
}

type SporeAuthority = { kind: 'grant'; grantId: string } | { kind: 'member' | 'run' };
export interface SporeExpectation { status?: SporeStatus; revision?: number }
export interface SporeSource { id: string; revision?: number }

const grantOf = (authority: SporeAuthority | undefined): string | null => authority?.kind === 'grant' ? authority.grantId : null;

const RESOLUTION_REFUSED = refusalCode('spore_resolution_refused');
const CONSOLIDATION_SOURCES_CHANGED = refusalCode('spore_consolidation_sources_changed');

type ResolveSlots = [project: string, event: string, spore: string, expected: string, activeToo: number, revision: number | null, grant: string | null,
  successor: string | null, successorActive: number];

const SOURCE_AS_EXPECTED = `(status=?4 OR (?5=1 AND status='active')) AND (?6 IS NULL OR revision=?6)`;
const EVENT_HELD = `EXISTS (SELECT 1 FROM resolution_events WHERE project_id=?1 AND id=?2)`;
const SUCCESSOR_BAD = `(?9=1 AND ?8 IS NOT NULL AND (?8=?3 OR NOT EXISTS (SELECT 1 FROM target WHERE status='active')))`;

const resolveAdmitted = assertion<ResolveSlots>({
  name: 'sporeLifecycle.resolveAdmitted',
  refusal: RESOLUTION_REFUSED,
  with: `WITH source AS (SELECT status,revision FROM spores WHERE project_id=?1 AND id=?3 AND (?7 IS NULL OR author=?7)),
    target AS (SELECT status FROM spores WHERE project_id=?1 AND id=?8 AND (?7 IS NULL OR author=?7))`,
  when: `EXISTS (SELECT 1 FROM source WHERE ${SOURCE_AS_EXPECTED}) AND NOT ${EVENT_HELD} AND NOT ${SUCCESSOR_BAD}`,
  detail: `CASE WHEN NOT EXISTS (SELECT 1 FROM source) THEN 'missing'
    WHEN ${EVENT_HELD} THEN 'duplicate'
    WHEN ?9=1 AND ?8=?3 THEN 'successor:self'
    WHEN ${SUCCESSOR_BAD} THEN 'successor:'||COALESCE((SELECT status FROM target),'missing')
    ELSE 'stale:'||(SELECT status FROM source)||':'||(SELECT revision FROM source) END`,
});

const insertEvent = write<[project: string, id: string, agent: string, spore: string, action: string, successor: string | null, reason: string | null, session: string | null,
  author: string | null, provenanceKind: string | null, provenanceRef: string | null, at: number]>({
  name: 'sporeLifecycle.insertEvent',
  sql: `INSERT INTO resolution_events (project_id,id,agent_id,spore_id,action,new_spore_id,reason,session_id,author,provenance_kind,provenance_ref,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
});

const moveSource = write<[status: string, at: number, project: string, id: string], { id: string }>({
  name: 'sporeLifecycle.moveSource',
  sql: `UPDATE spores SET status=?1,revision=revision+1,updated_at=?2 WHERE project_id=?3 AND id=?4 RETURNING id`,
});

/** A source that is not at the status and revision the caller read. */
interface StaleSpore { error: 'stale'; reason: string; status: string; revision: number }
/** Why a successor cannot take a source's place: it is the source, is gone, or has itself left the active set. */
interface InvalidSuccessor { error: 'successor'; state: string }
type ResolveOutcome = true | false | 'duplicate' | 'import_disabled' | StaleSpore | InvalidSuccessor;

interface ResolveRequest {
  status: SporeStatus;
  event: ResolutionEventInsert;
  now: number;
  expect?: SporeExpectation;
  authority?: SporeAuthority;
}

/** Import history admits its expected final state as well as a source that is still active, and may name a successor it has not carried in yet. */
function resolveOutcomeOf(detail: string, request: ResolveRequest, expected: string): ResolveOutcome {
  if (detail === 'missing') return false;
  if (detail === 'duplicate') return 'duplicate';
  if (detail.startsWith('successor:')) return { error: 'successor', state: detail.slice('successor:'.length) };
  const [, status, revision] = detail.split(':') as [string, string, string];
  const active = request.event.channel === 'import' && expected !== 'active' ? ' or active' : '';
  const at = request.expect?.revision === undefined ? '' : ` at revision ${request.expect.revision}`;
  return { error: 'stale', status, revision: Number(revision), reason: `source is ${status} at revision ${revision}; expected ${expected}${active}${at}` };
}

/** Move a spore and record its event atomically; a replayed event id changes nothing. */
export async function resolveSpore(db: RelationalStore, scope: ReadScope, request: ResolveRequest): Promise<ResolveOutcome> {
  const { event, status, now, expect = {}, authority } = request;
  const imported = event.channel === 'import';
  const expected = expect.status ?? (imported ? status : 'active');
  try {
    await commitNamed(db, {
      imported: imported ? [importAdmittedAssertion()] : [],
      admitted: resolveAdmitted.bind(scope.projectId, event.id, event.sporeId, expected, imported ? 1 : 0, expect.revision ?? null, grantOf(authority),
        event.newSporeId, imported ? 0 : 1),
      event: insertEvent.bind(scope.projectId, event.id, event.agentId, event.sporeId, event.action, event.newSporeId, event.reason, event.sessionId,
        event.author, event.provenance?.kind ?? null, event.provenance?.ref ?? null, event.createdAt),
      move: moveSource.bind(status, now, scope.projectId, event.sporeId),
    });
    return true;
  } catch (error) {
    if (importRefused(error)) return 'import_disabled';
    const detail = refusalDetail(error, RESOLUTION_REFUSED);
    if (detail === null) throw error;
    return resolveOutcomeOf(detail, request, expected);
  }
}

type SourceSlots = [project: string, sources: string, grant: string | null];

const STALE_SOURCE = `status IS NULL OR status<>'active' OR (expected IS NOT NULL AND current<>expected)`;

const sourcesCurrent = assertion<SourceSlots>({
  name: 'sporeLifecycle.consolidationSourcesCurrent',
  refusal: CONSOLIDATION_SOURCES_CHANGED,
  with: `WITH held AS (SELECT CAST(j.key AS INTEGER) AS position,s.status,s.revision AS current,json_extract(j.value,'$.revision') AS expected
      FROM json_each(?2) j LEFT JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id') AND (?3 IS NULL OR s.author=?3))`,
  when: `json_array_length(?2)>0 AND NOT EXISTS (SELECT 1 FROM held WHERE ${STALE_SOURCE})`,
  detail: `(SELECT position||':'||COALESCE(status,'')||':'||COALESCE(current,'') FROM held WHERE ${STALE_SOURCE} ORDER BY position LIMIT 1)`,
});

const insertSourceEvents = write<[project: string, sources: string, agent: string, successor: string, reason: string | null, session: string | null,
  author: string | null, provenanceKind: string | null, provenanceRef: string | null, at: number]>({
  name: 'sporeLifecycle.insertSourceEvents',
  sql: `INSERT INTO resolution_events (project_id,id,agent_id,spore_id,action,new_spore_id,reason,session_id,author,provenance_kind,provenance_ref,created_at)
    SELECT ?1,json_extract(j.value,'$.event'),?3,s.id,'consolidate',?4,?5,?6,?7,?8,?9,?10
    FROM json_each(?2) j CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id') WHERE +s.status='active'`,
});

const moveSources = write<[at: number, project: string, sources: string], { id: string }>({
  name: 'sporeLifecycle.moveSources',
  sql: `UPDATE spores SET status='consolidated',revision=revision+1,updated_at=?1
    WHERE (project_id,id) IN (SELECT ?2,json_extract(value,'$.id') FROM json_each(?3)) AND +status='active' RETURNING id`,
});

/** The source a consolidation refused on, what the commit found, and what the caller read. */
interface StaleConsolidationSource { id: string; status: string | null; revision: number | null; expected: number | null }

type ConsolidationEvent = Omit<ResolutionEventInsert, 'id' | 'sporeId' | 'action' | 'newSporeId'>;

interface ConsolidationRequest {
  wisdom: SporeInsert;
  sources: readonly SporeSource[];
  event: ConsolidationEvent;
  now: number;
  authority?: SporeAuthority;
}

type ConsolidationOutcome =
  | { wisdom: SporeRow; consolidated: number; stale?: undefined }
  | { wisdom: null; consolidated: 0; stale: StaleConsolidationSource };

function staleSourceFrom(detail: string, sources: readonly SporeSource[]): StaleConsolidationSource {
  if (detail === '') return { id: '', status: null, revision: null, expected: null };
  const [position, status, revision] = detail.split(':') as [string, string, string];
  const source = sources[Number(position)]!;
  return { id: source.id, status: status === '' ? null : status, revision: revision === '' ? null : Number(revision), expected: source.revision ?? null };
}

/**
 * Record one wisdom spore and move every source to consolidated, each with its event, in one commit that lands only while every source is still active at
 * its expected revision. When one changed, nothing is stored and `stale` names the first source that changed, so the caller rereads it.
 */
export async function consolidateSpores(db: RelationalStore, scope: ReadScope, request: ConsolidationRequest): Promise<ConsolidationOutcome> {
  const { wisdom, sources, event, now, authority } = request;
  const encoded = JSON.stringify(sources.map(source => ({ id: source.id, revision: source.revision ?? null, event: crypto.randomUUID() })));
  try {
    const committed = await commitNamed(db, {
      admitted: sourcesCurrent.bind(scope.projectId, encoded, grantOf(authority)),
      wisdom: sporeInsertWrite(scope, wisdom),
      events: insertSourceEvents.bind(scope.projectId, encoded, event.agentId, wisdom.id, event.reason, event.sessionId, event.author,
        event.provenance?.kind ?? null, event.provenance?.ref ?? null, event.createdAt),
      moved: moveSources.bind(now, scope.projectId, encoded),
    });
    return { wisdom: committed.wisdom.results[0]!, consolidated: committed.moved.results.length };
  } catch (error) {
    const detail = refusalDetail(error, CONSOLIDATION_SOURCES_CHANGED);
    if (detail === null) throw error;
    return { wisdom: null, consolidated: 0, stale: staleSourceFrom(detail, sources) };
  }
}

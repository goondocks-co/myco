import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { assertion, read, readSet, refusalCode, refused } from '../index.js';
import { prepareBound } from '../kernel/statement.js';

/** The refusal an aborted consolidation carries: it stores no wisdom spore and moves no source. */
export const CONSOLIDATION_SOURCES_CHANGED = refusalCode('spore_consolidation_sources_changed');

export interface ConsolidationSource { id: string; revision?: number }
export interface StaleConsolidationSource { id: string; status: string | null; revision: number | null; expected: number | null }

const STALE = `FROM json_each(?2) j LEFT JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id')
  WHERE s.id IS NULL OR s.status<>'active' OR (json_extract(j.value,'$.revision') IS NOT NULL AND s.revision<>json_extract(j.value,'$.revision'))`;

const sourcesCurrent = assertion<[project: string, sources: string]>({ name: 'sporeConsolidation.sourcesCurrent', refusal: CONSOLIDATION_SOURCES_CHANGED, when: `NOT EXISTS (SELECT 1 ${STALE})` });
const staleSource = read<[project: string, sources: string], StaleConsolidationSource>({ name: 'sporeConsolidation.staleSource', sql:
  `SELECT json_extract(j.value,'$.id') AS id,s.status,s.revision,json_extract(j.value,'$.revision') AS expected ${STALE} ORDER BY j.key LIMIT 1` });

const encode = (sources: readonly ConsolidationSource[]) => JSON.stringify(sources.map(({ id, revision }) => ({ id, revision: revision ?? null })));

/** Aborts the consolidation batch unless every source is still active, at its expected revision where one is given. */
export function consolidationSourcesCurrent(db: RelationalStore, projectId: string, sources: readonly ConsolidationSource[]): PreparedStatement {
  return prepareBound(db, sourcesCurrent.bind(projectId, encode(sources)));
}

/** The first source that is missing, no longer active, or past its expected revision; null when all are current. */
export async function staleConsolidationSource(db: RelationalStore, projectId: string, sources: readonly ConsolidationSource[]): Promise<StaleConsolidationSource | null> {
  const [rows] = await readSet(db, staleSource.bind(projectId, encode(sources)));
  return rows[0] ?? null;
}

export function consolidationSourcesChanged(error: unknown): boolean {
  return refused(error, CONSOLIDATION_SOURCES_CHANGED);
}

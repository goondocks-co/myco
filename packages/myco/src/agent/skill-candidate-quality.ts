import { getDatabase } from '@myco/db/client.js';
import { projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { parseSourceRefsWithRawCount } from './skill-candidate-evidence.js';

import { validateSkillCandidateQualityContract as validateQuality, IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS, type CandidateQualityContractRow } from '@goondocks/myco-shared/skill-candidates';
export * from '@goondocks/myco-shared/skill-candidates';

export interface CandidateQualityContractOptions {
  requireResolvedSources?: boolean;
  scope?: ProjectScope;
}

export function validateSkillCandidateQualityContract(
  candidate: CandidateQualityContractRow,
  options: CandidateQualityContractOptions = {},
): string[] {
  const issues = validateQuality(candidate);
  const { refs, rawCount } = parseSourceRefsWithRawCount(candidate.source_ids);
  if (options.requireResolvedSources && rawCount === refs.length && refs.length >= IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS) {
    if (!options.scope) issues.push('project scope is required to resolve source_ids');
    else {
      const missing = missingSourceRefs(refs, options.scope);
      if (missing.length > 0) issues.push(`source_ids reference missing vault records: ${missing.map((ref) => `${ref.type}:${ref.id}`).join(', ')}`);
    }
  }
  return issues;
}

/**
 * Returns the subset of `refs` whose target vault record does not exist under
 * `scope`. One DB round-trip per source TYPE (spore / session / plan /
 * artifact). A ref resolves when a stored id equals it OR begins with it —
 * source refs are frequently recorded in Myco's 8-char short-id form (the
 * display/reference format used everywhere else), while the tables store full
 * ids. An exact-only `id IN (...)` match silently reported short-id refs as
 * "missing" and 400'd otherwise-valid candidate approvals.
 */
function missingSourceRefs(
  refs: ReadonlyArray<ReturnType<typeof parseSourceRefsWithRawCount>['refs'][number]>,
  scope: ProjectScope,
): Array<ReturnType<typeof parseSourceRefsWithRawCount>['refs'][number]> {
  if (refs.length === 0) return [];
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    const ids = byType.get(ref.type) ?? [];
    ids.push(ref.id);
    byType.set(ref.type, ids);
  }
  const resolved = new Map<string, Set<string>>();
  for (const [type, ids] of byType) {
    resolved.set(type, resolvedRefIdsForType(type, ids, scope));
  }
  return refs.filter((ref) => !(resolved.get(ref.type)?.has(ref.id) ?? false));
}

const SOURCE_REF_TABLE_BY_TYPE: Record<string, string> = {
  spore: 'spores',
  session: 'sessions',
  plan: 'plans',
  artifact: 'artifacts',
};

/**
 * Of the given `refIds`, return those that resolve to a stored record under
 * `scope` — by exact id OR by prefix (a short id is a prefix of the full
 * stored id). Uses `substr(id, 1, length(ref)) = ref` rather than `LIKE` to
 * sidestep wildcard characters in ids; the JS pass re-confirms the prefix.
 */
function resolvedRefIdsForType(type: string, refIds: string[], scope: ProjectScope): Set<string> {
  const table = SOURCE_REF_TABLE_BY_TYPE[type];
  if (!table || refIds.length === 0) return new Set();
  const clause = projectScopeClause(scope);
  const conds = refIds.map(() => '(id = ? OR substr(id, 1, ?) = ?)').join(' OR ');
  const params: Array<string | number> = [];
  for (const id of refIds) params.push(id, id.length, id);
  const rows = getDatabase()
    .prepare(`SELECT id FROM ${table} WHERE (${conds})${clause.sql}`)
    .all(...params, ...clause.params) as Array<{ id: string }>;
  const storedIds = rows.map((row) => row.id);
  const resolved = new Set<string>();
  for (const ref of refIds) {
    if (storedIds.some((stored) => stored === ref || stored.startsWith(ref))) {
      resolved.add(ref);
    }
  }
  return resolved;
}

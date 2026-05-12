import type { Database } from 'bun:sqlite';
import {
  getReleaseState,
  getReleaseStatesForRecords,
  type ReleaseConfidence,
  type ReleaseNamespace,
  type ReleaseStateRow,
  type ReleaseStateValue,
} from '@myco/db/queries/release-provenance.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';

export interface ReleaseStateAnnotation {
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basis_kind: string | null;
  basis_ref?: string | null;
  checked_at: number;
  reason?: string | null;
}

function annotationFromRow(row: ReleaseStateRow): ReleaseStateAnnotation {
  return {
    state: row.state,
    confidence: row.confidence,
    basis_kind: row.basis_kind,
    basis_ref: row.basis_ref,
    checked_at: row.checked_at,
    reason: row.reason,
  };
}

export function releaseStateAnnotation(
  namespace: ReleaseNamespace,
  recordId: string,
  scope: ProjectScope,
  db?: Database,
): ReleaseStateAnnotation | null {
  const row = getReleaseState(namespace, recordId, scope, db);
  return row ? annotationFromRow(row) : null;
}

/**
 * Bulk-load annotations for many record ids in one namespace. Use this in
 * search/list hot paths to avoid an N+1 lookup per result row.
 */
export function releaseStateAnnotationMap(
  namespace: ReleaseNamespace,
  recordIds: readonly string[],
  scope: ProjectScope,
  db?: Database,
): Map<string, ReleaseStateAnnotation> {
  const rows = getReleaseStatesForRecords(namespace, recordIds, scope, db);
  const out = new Map<string, ReleaseStateAnnotation>();
  for (const [id, row] of rows) out.set(id, annotationFromRow(row));
  return out;
}

/**
 * Spread helper for result-shape construction. Returns an object that, when
 * spread, contributes either `{ release_state }` or nothing.
 */
export function releaseStateField(
  annotation: ReleaseStateAnnotation | undefined | null,
): { release_state?: ReleaseStateAnnotation } {
  return annotation ? { release_state: annotation } : {};
}

export function releaseStateMetadata(annotation: ReleaseStateAnnotation | null): Record<string, unknown> {
  if (!annotation) return {};
  return {
    release_state: annotation.state,
    release_confidence: annotation.confidence,
    release_basis_kind: annotation.basis_kind,
    release_checked_at: annotation.checked_at,
  };
}

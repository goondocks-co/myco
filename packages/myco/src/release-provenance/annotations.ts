import type { Database } from 'bun:sqlite';
import {
  getReleaseState,
  type ReleaseConfidence,
  type ReleaseNamespace,
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

export function releaseStateAnnotation(
  namespace: ReleaseNamespace,
  recordId: string,
  scope: ProjectScope,
  db?: Database,
): ReleaseStateAnnotation | null {
  const row = getReleaseState(namespace, recordId, scope, db);
  if (!row) return null;
  return {
    state: row.state,
    confidence: row.confidence,
    basis_kind: row.basis_kind,
    basis_ref: row.basis_ref,
    checked_at: row.checked_at,
    reason: row.reason,
  };
}

export function applyReleaseStateFields<T extends Record<string, unknown>>(
  target: T,
  annotation: ReleaseStateAnnotation | null,
): T {
  if (!annotation) return target;
  return {
    ...target,
    release_state: annotation,
  };
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

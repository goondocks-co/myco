/**
 * Propagate release-state into vector domain_metadata so semantic-search
 * filters by `release_state` stay in sync with reconciliation. The patch is
 * metadata-only — never touches the embedding column, so release-state
 * updates do not trigger re-embedding.
 */

import type { Database } from 'bun:sqlite';
import { EMBEDDABLE_NAMESPACES, type DomainMetadata, type VectorStore } from '@myco/daemon/embedding/types.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import type {
  ReleaseConfidence,
  ReleaseNamespace,
  ReleaseStateValue,
} from '@myco/db/queries/release-provenance.js';
import { findDerivedRecords } from './record-lineage.js';

const EMBEDDABLE_NAMESPACE_SET: ReadonlySet<string> = new Set(EMBEDDABLE_NAMESPACES);

export interface ReleaseMetadataPatch {
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basis_kind: string | null;
  checked_at: number;
}

export interface RefreshReleaseVectorMetadataInput {
  store: VectorStore;
  db: Database;
  scope: ProjectScope;
  sourceNamespace: ReleaseNamespace;
  sourceRecordId: string;
  patch: ReleaseMetadataPatch;
}

function toDomainPatch(patch: ReleaseMetadataPatch): Partial<DomainMetadata> {
  return {
    release_state: patch.state,
    release_confidence: patch.confidence,
    release_basis_kind: patch.basis_kind,
    release_checked_at: patch.checked_at,
  };
}

/**
 * Patch domain metadata for the source record and any derived embeddable
 * records. Records that aren't embedded yet are silently skipped — once they
 * embed, `record-source.ts` includes release metadata from `getReleaseState`.
 */
export function refreshReleaseVectorMetadata(input: RefreshReleaseVectorMetadataInput): { patched: number } {
  const domainPatch = toDomainPatch(input.patch);
  let patched = 0;
  // Source rows may live in namespaces that aren't themselves embeddable
  // (e.g. prompt_batches): the SQL annotation lookup uses the materialized
  // knowledge_release_state row, and there's no vector to patch. Skip rather
  // than throwing — the vector store rejects unknown namespaces.
  if (EMBEDDABLE_NAMESPACE_SET.has(input.sourceNamespace)
    && input.store.patchDomainMetadata(input.sourceNamespace, input.sourceRecordId, domainPatch)) {
    patched++;
  }
  const derived = findDerivedRecords({
    sourceNamespace: input.sourceNamespace,
    sourceRecordId: input.sourceRecordId,
    scope: input.scope,
    db: input.db,
  });
  for (const record of derived) {
    if (!EMBEDDABLE_NAMESPACE_SET.has(record.namespace)) continue;
    if (input.store.patchDomainMetadata(record.namespace, record.recordId, domainPatch)) {
      patched++;
    }
  }
  return { patched };
}

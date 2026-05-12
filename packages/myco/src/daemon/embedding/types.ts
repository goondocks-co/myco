/**
 * Types and interfaces for the embedding lifecycle subsystem.
 *
 * Defines the contracts between the EmbeddingManager, VectorStore,
 * EmbeddableRecordSource, and ManagerEmbeddingProvider.
 */

/**
 * Re-export from the DB layer — single source of truth for embeddable table names.
 * Aliased as "namespaces" in the embedding subsystem since the VectorStore is DB-agnostic.
 */
export { EMBEDDABLE_TABLES as EMBEDDABLE_NAMESPACES, type EmbeddableTable as EmbeddableNamespace } from '@myco/db/queries/embeddings.js';

/** Domain metadata passed by callers alongside content. */
export interface DomainMetadata {
  status?: string;
  session_id?: string;
  observation_type?: string;
  project_root?: string;
  name?: string;
  source_path?: string;
  created_at?: number;
  project_id?: string;
  path?: string;
  language?: string;
  release_state?: string;
  release_confidence?: string;
  release_basis_kind?: string | null;
  release_checked_at?: number;
}

/** Full metadata stored per vector in the VectorStore. */
export interface EmbeddingMetadata {
  namespace: string;
  record_id: string;
  model: string;
  provider: string;
  dimensions: number;
  content_hash: string;
  embedded_at: number;
  status?: string;
  session_id?: string;
  observation_type?: string;
  project_root?: string;
  name?: string;
  source_path?: string;
  created_at?: number;
  project_id?: string;
  path?: string;
  language?: string;
  release_state?: string;
  release_confidence?: string;
  release_basis_kind?: string | null;
  release_checked_at?: number;
}

/** Result from similarity search. */
export interface VectorSearchResult {
  id: string;
  namespace: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

/** Stats returned by VectorStore for the operations UI. */
export interface VectorStoreStats {
  total: number;
  by_namespace: Record<string, { embedded: number; stale: number }>;
  models: Record<string, number>;
}

/** Extends VectorStoreStats with pending counts and provider info for the UI. */
export interface EmbeddingDetails extends VectorStoreStats {
  pending: Record<string, number>;
  provider: { name: string; model: string; available: boolean };
}

/** Result of a reconciliation cycle. */
export interface ReconcileResult {
  embedded: number;
  stale_reembedded: number;
  orphans_cleaned: number;
  duration_ms: number;
}

/** VectorStore — owns vectors and metadata, fully decoupled from record store. */
export interface VectorStore {
  upsert(namespace: string, id: string, embedding: number[], metadata?: Record<string, unknown>): void;
  remove(namespace: string, id: string): void;
  clear(namespace?: string): { cleared: number };
  search(query: number[], options?: {
    namespace?: string;
    limit?: number;
    threshold?: number;
    filters?: Record<string, unknown>;
  }): VectorSearchResult[];
  stats(options?: { namespace?: string; projectId?: string | null }): VectorStoreStats;
  getStaleIds(namespace: string, currentModel: string, limit: number): string[];
  getEmbeddedIds(namespace: string): string[];
  pairwiseSimilarity(namespace: string, threshold?: number): Array<{ idA: string; idB: string; similarity: number }>;
  /**
   * Patch the `domain_metadata` JSON column for one record without re-embedding.
   * Used by release-provenance reconciliation to propagate state/confidence
   * changes into vector metadata so semantic-search filters stay in sync.
   *
   * Returns true when a row existed; false when the record is not embedded
   * yet (no metadata row to patch). Implementations must perform a metadata-
   * only UPDATE; they must not touch the embedding column.
   */
  patchDomainMetadata(namespace: string, recordId: string, patch: Partial<DomainMetadata>): boolean;
}

/** Generates vectors from text. Wraps the existing EmbeddingProvider. */
export interface ManagerEmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
  readonly model: string;
  readonly providerName: string;
  readonly dimensions: number;
}

/** Queries the record store for rows that need embedding. */
export interface EmbeddableRecordSource {
  getEmbeddableRows(namespace: string, limit: number): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }>;
  getActiveRecordIds(namespace: string): string[];
  getRecordContent(namespace: string, ids: string[]): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }>;
  markEmbedded(namespace: string, id: string): void;
  clearEmbedded(namespace: string, id: string): void;
  clearAllEmbedded(namespace?: string): void;
  /** Count rows that need embedding (SELECT COUNT, not materialized). */
  getPendingCount(namespace: string): number;
}

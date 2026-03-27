/**
 * EmbeddingManager — orchestrates the embedding lifecycle.
 *
 * Coordinates three injected dependencies:
 *   - VectorStore: stores/retrieves vectors (sync, sqlite-vec)
 *   - ManagerEmbeddingProvider: generates vectors from text (async)
 *   - EmbeddableRecordSource: queries record store for embeddable rows (sync)
 *
 * All write-path methods (onContentWritten, onStatusChanged, onRemoved) are
 * fire-and-forget safe — they catch and log errors, never throw.
 *
 * The reconcile() method is called by the reconcile worker on a timer.
 * Operations UI calls rebuildAll(), cleanOrphans(), getDetails().
 */

import { createHash } from 'node:crypto';
import { CONTENT_HASH_ALGORITHM, epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  EMBEDDABLE_NAMESPACES,
  type EmbeddableNamespace,
  type DomainMetadata,
  type EmbeddingDetails,
  type ReconcileResult,
  type VectorStore,
  type VectorSearchResult,
  type ManagerEmbeddingProvider,
  type EmbeddableRecordSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spore status that qualifies for embedding. */
const ACTIVE_STATUS = 'active';

// ---------------------------------------------------------------------------
// Logger interface (matches DaemonLogger method signatures)
// ---------------------------------------------------------------------------

interface Logger {
  debug(cat: string, msg: string, data?: Record<string, unknown>): void;
  info(cat: string, msg: string, data?: Record<string, unknown>): void;
  warn(cat: string, msg: string, data?: Record<string, unknown>): void;
  error(cat: string, msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// EmbeddingManager
// ---------------------------------------------------------------------------

export class EmbeddingManager {
  constructor(
    private vectorStore: VectorStore,
    private embeddingProvider: ManagerEmbeddingProvider,
    private recordSource: EmbeddableRecordSource,
    private logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private contentHash(text: string): string {
    return createHash(CONTENT_HASH_ALGORITHM).update(text).digest('hex');
  }

  // -------------------------------------------------------------------------
  // Write-path event handlers
  // -------------------------------------------------------------------------

  /**
   * Called when content is written (session note, spore, plan, artifact).
   * Embeds the text and stores the vector. Fire-and-forget safe.
   */
  async onContentWritten(
    namespace: EmbeddableNamespace,
    id: string,
    text: string,
    metadata: DomainMetadata,
  ): Promise<void> {
    try {
      const embedding = await this.embeddingProvider.embed(text);
      if (embedding === null) {
        this.logger.warn(LOG_KINDS.EMBEDDING_PROVIDER, 'Provider unavailable, skipping embed', {
          namespace,
          id,
        });
        return;
      }

      const hash = this.contentHash(text);

      this.vectorStore.upsert(namespace, id, embedding, {
        model: this.embeddingProvider.model,
        provider: this.embeddingProvider.providerName,
        dimensions: this.embeddingProvider.dimensions,
        content_hash: hash,
        embedded_at: epochSeconds(),
        domain_metadata: metadata,
      });

      this.recordSource.markEmbedded(namespace, id);

      this.logger.debug(LOG_KINDS.EMBEDDING_EMBED, 'Vector stored', { namespace, id });
    } catch (err) {
      this.logger.warn(LOG_KINDS.EMBEDDING_EMBED, 'Failed to embed content', {
        namespace,
        id,
        error: String(err),
      });
    }
  }

  /**
   * Called when a spore's status changes (e.g., superseded, archived).
   * Removes the vector for non-active statuses.
   */
  onStatusChanged(namespace: 'spores', id: string, status: string): void {
    try {
      if (status === ACTIVE_STATUS) return;

      this.vectorStore.remove(namespace, id);
      this.recordSource.clearEmbedded(namespace, id);

      this.logger.debug(LOG_KINDS.EMBEDDING_CLEANUP, 'Vector removed', {
        namespace,
        id,
        reason: `status=${status}`,
      });
    } catch (err) {
      this.logger.warn(LOG_KINDS.EMBEDDING_CLEANUP, 'Failed to remove vector on status change', {
        namespace,
        id,
        status,
        error: String(err),
      });
    }
  }

  /**
   * Called when a record is deleted. Removes the vector.
   * No clearEmbedded needed — the record itself is being deleted.
   */
  onRemoved(namespace: EmbeddableNamespace, id: string): void {
    try {
      this.vectorStore.remove(namespace, id);

      this.logger.debug(LOG_KINDS.EMBEDDING_CLEANUP, 'Vector removed', {
        namespace,
        id,
        reason: 'record deleted',
      });
    } catch (err) {
      this.logger.warn(LOG_KINDS.EMBEDDING_CLEANUP, 'Failed to remove vector on delete', {
        namespace,
        id,
        error: String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Embed missing rows, re-embed stale vectors, and clean orphans across all namespaces.
   * Called by the reconcile worker on a timer.
   */
  async reconcile(batchSize: number): Promise<ReconcileResult> {
    const start = Date.now();
    let embedded = 0;
    let stale_reembedded = 0;
    let orphans_cleaned = 0;
    const currentModel = this.embeddingProvider.model;

    for (const namespace of EMBEDDABLE_NAMESPACES) {
      // Phase 1: Embed missing rows
      const rows = this.recordSource.getEmbeddableRows(namespace, batchSize);

      for (const row of rows) {
        const embedding = await this.embeddingProvider.embed(row.text);
        if (embedding === null) {
          this.logger.warn(LOG_KINDS.EMBEDDING_PROVIDER, 'Provider unavailable during reconcile, returning partial progress', {
            namespace,
            embedded,
          });
          return {
            embedded,
            stale_reembedded,
            orphans_cleaned,
            duration_ms: Date.now() - start,
          };
        }

        const hash = this.contentHash(row.text);

        this.vectorStore.upsert(namespace, row.id, embedding, {
          model: currentModel,
          provider: this.embeddingProvider.providerName,
          dimensions: this.embeddingProvider.dimensions,
          content_hash: hash,
          embedded_at: epochSeconds(),
          domain_metadata: row.metadata,
        });

        this.recordSource.markEmbedded(namespace, row.id);
        embedded++;
      }

      // Phase 2: Re-embed stale vectors (model mismatch)
      const staleIds = this.vectorStore.getStaleIds(namespace, currentModel, batchSize);
      if (staleIds.length > 0) {
        const records = this.recordSource.getRecordContent(namespace, staleIds);
        const foundIds = new Set(records.map((r) => r.id));

        for (const record of records) {
          const embedding = await this.embeddingProvider.embed(record.text);
          if (embedding === null) {
            this.logger.warn(LOG_KINDS.EMBEDDING_PROVIDER, 'Provider unavailable during stale re-embed, returning partial progress', {
              namespace,
              stale_reembedded,
            });
            return {
              embedded,
              stale_reembedded,
              orphans_cleaned,
              duration_ms: Date.now() - start,
            };
          }

          this.vectorStore.upsert(namespace, record.id, embedding, {
            model: currentModel,
            provider: this.embeddingProvider.providerName,
            dimensions: this.embeddingProvider.dimensions,
            content_hash: this.contentHash(record.text),
            embedded_at: epochSeconds(),
            domain_metadata: record.metadata,
          });

          stale_reembedded++;
        }

        // Clean stale vectors whose source records no longer exist
        for (const staleId of staleIds) {
          if (!foundIds.has(staleId)) {
            this.vectorStore.remove(namespace, staleId);
            this.logger.warn(LOG_KINDS.EMBEDDING_CLEANUP, 'Stale orphan vector cleaned', {
              namespace,
              id: staleId,
            });
            orphans_cleaned++;
          }
        }
      }

      // Phase 3: Orphan sweep
      orphans_cleaned += this.sweepOrphans(namespace);
    }

    const duration_ms = Date.now() - start;

    if (embedded > 0 || stale_reembedded > 0 || orphans_cleaned > 0) {
      this.logger.info(LOG_KINDS.EMBEDDING_RECONCILE, 'Reconcile cycle completed', {
        embedded,
        stale_reembedded,
        orphans_cleaned,
        duration_ms,
      });
    }

    return { embedded, stale_reembedded, orphans_cleaned, duration_ms };
  }

  /**
   * Remove orphan vectors (vectors without corresponding active records).
   */
  cleanOrphans(): { orphans_cleaned: number } {
    let orphans_cleaned = 0;
    for (const namespace of EMBEDDABLE_NAMESPACES) {
      orphans_cleaned += this.sweepOrphans(namespace);
    }
    return { orphans_cleaned };
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Clear all vectors and reset embedded flags.
   * The reconcile worker picks up all rows on subsequent cycles.
   */
  rebuildAll(): { queued: number } {
    const { cleared } = this.vectorStore.clear();
    this.recordSource.clearAllEmbedded();

    this.logger.info(LOG_KINDS.EMBEDDING_REBUILD, 'Rebuild started', { cleared });

    return { queued: cleared };
  }

  /**
   * Re-embed vectors that were created with a different model.
   */
  async reembedStale(batchSize: number): Promise<{ reembedded: number }> {
    let reembedded = 0;
    const currentModel = this.embeddingProvider.model;

    for (const namespace of EMBEDDABLE_NAMESPACES) {
      const staleIds = this.vectorStore.getStaleIds(namespace, currentModel, batchSize);
      if (staleIds.length === 0) continue;

      const records = this.recordSource.getRecordContent(namespace, staleIds);

      for (const record of records) {
        const embedding = await this.embeddingProvider.embed(record.text);
        if (embedding === null) {
          this.logger.warn(LOG_KINDS.EMBEDDING_PROVIDER, 'Provider unavailable during re-embed', {
            namespace,
            reembedded,
          });
          return { reembedded };
        }

        const hash = this.contentHash(record.text);

        this.vectorStore.upsert(namespace, record.id, embedding, {
          model: currentModel,
          provider: this.embeddingProvider.providerName,
          dimensions: this.embeddingProvider.dimensions,
          content_hash: hash,
          embedded_at: epochSeconds(),
          domain_metadata: record.metadata,
        });

        reembedded++;
      }
    }

    return { reembedded };
  }

  /**
   * Get details for the operations UI: vector stats, pending counts, provider info.
   */
  getDetails(): EmbeddingDetails {
    const stats = this.vectorStore.stats();

    const pending: Record<string, number> = {};
    for (const namespace of EMBEDDABLE_NAMESPACES) {
      pending[namespace] = this.recordSource.getPendingCount(namespace);
    }

    return {
      ...stats,
      pending,
      provider: {
        name: this.embeddingProvider.providerName,
        model: this.embeddingProvider.model,
        available: true, // If we got here, the manager was constructed with a provider
      },
    };
  }

  /**
   * Pass-through for search handler — embed a query string.
   */
  async embedQuery(text: string): Promise<number[] | null> {
    return this.embeddingProvider.embed(text);
  }

  /**
   * Pass-through for search handler — similarity search via the vector store.
   * Keeps the VectorStore private to the manager.
   */
  searchVectors(query: number[], options?: {
    namespace?: string;
    limit?: number;
    threshold?: number;
    filters?: Record<string, unknown>;
  }): VectorSearchResult[] {
    return this.vectorStore.search(query, options);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Sweep orphan vectors for a single namespace. Returns count removed.
   *
   * Compares vector IDs against active record IDs — vectors without a matching
   * active record are removed. Does NOT short-circuit on count equality because
   * equal counts can mask orphans (e.g., 3 orphan vectors + 3 active records
   * missing vectors = same count, zero cleanup).
   */
  private sweepOrphans(namespace: EmbeddableNamespace): number {
    const embeddedIds = this.vectorStore.getEmbeddedIds(namespace);
    if (embeddedIds.length === 0) return 0;

    const activeIds = this.recordSource.getActiveRecordIds(namespace);
    const activeSet = new Set(activeIds);
    let cleaned = 0;

    for (const vecId of embeddedIds) {
      if (!activeSet.has(vecId)) {
        this.vectorStore.remove(namespace, vecId);
        this.logger.warn(LOG_KINDS.EMBEDDING_CLEANUP, 'Orphan vector cleaned', {
          namespace,
          id: vecId,
        });
        cleaned++;
      }
    }

    return cleaned;
  }
}

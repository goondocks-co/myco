import type { UpsertRule } from '../../meta/server-upsert-inventory.js';

export const RECONCILIATION_MATRICES = {
  plan: { 'ingest/projections.ts#plan': ['event-rank'] },
  provenance: { 'ingest/projections.ts#sessionCommit': ['event-rank'] },
  roots: {},
  embedding: { 'core/settings.ts#writeEmbedding': ['writer-revision'] },
  catalog: { 'core/model-catalogs.ts#recordModelCatalog': ['reporter-stamp'] },
  runner: { 'core/runner-updates.ts#runnerUpdateReportStatements': ['reporter-stamp'] },
} satisfies Record<string, Record<string, UpsertRule[]>>;

export type ReconciliationCase = keyof typeof RECONCILIATION_MATRICES;
export const RECONCILIATION_CASES = Object.keys(RECONCILIATION_MATRICES) as ReconciliationCase[];

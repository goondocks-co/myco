import type { UpsertRule } from '../../meta/server-upsert-inventory.js';

export const RECONCILIATION_MATRICES = {
  plan: { 'ingest/projections.ts#plan': ['event-rank'] },
  provenance: { 'ingest/projections.ts#sessionCommit': ['event-rank'] },
  roots: {},
  embedding: { 'db/settings/leaves.ts#<module>': ['writer-revision'] },
  catalog: { 'db/runners/catalogs.ts#upsert': ['reporter-stamp'] },
  runner: { 'db/runners/updates.ts#<module>': ['reporter-stamp'] },
  budget: { 'db/meta/budget-activation.ts#indexWitness': ['catalogue-snapshot'] },
} satisfies Record<string, Record<string, UpsertRule[]>>;

export type ReconciliationCase = keyof typeof RECONCILIATION_MATRICES;
export const RECONCILIATION_CASES = Object.keys(RECONCILIATION_MATRICES) as ReconciliationCase[];

export const PLATFORM_RECONCILIATION_MATRICES = {
  'platform/bun/vectors.ts#upsert': ['content-key'],
  'platform/cloudflare/recovery-producer-object.ts#checkpoint': ['checkpoint-transaction', 'checkpoint-transaction'],
} satisfies Record<string, UpsertRule[]>;

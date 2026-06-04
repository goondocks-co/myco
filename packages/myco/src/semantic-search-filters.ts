import type { EmbeddingMetadata } from '@myco/daemon/embedding/types.js';

/**
 * Single source of truth for how each filterable `domain_metadata` key is
 * applied in the vector store. The sqlite-vec store derives its vec0 schema,
 * its upsert column projection, and its KNN query routing from this one
 * registry — so the filterable-key set is defined once, here, alongside the
 * post-fetch matcher (`matchesSemanticSearchFilters`) that must agree with it.
 *
 *   - `'partition'` → a vec0 partition key. Equality-only; the tenancy scope.
 *   - `'column'`    → a vec0 metadata column (TEXT), filtered INSIDE the KNN so
 *                     a small `k` still returns the top-k OF MATCHING rows.
 *                     ONLY for keys that are (a) equality-filtered, (b) short
 *                     (<12 chars — sqlite-vec's efficient bound), and (c)
 *                     STABLE for the vector's lifetime: set at embed, and any
 *                     change re-embeds or removes the vector (so the column can
 *                     never go stale). Missing binds the `''` sentinel, which
 *                     is correct for equality (`'' ≠ any real value`) but WRONG
 *                     for comparisons — which is exactly why range keys are
 *                     never columns.
 *   - `'postKnn'`   → filtered AFTER the KNN via `json_extract` on the live
 *                     `domain_metadata` JSON (over an over-fetched candidate
 *                     pool). Required for: RANGE/nullable keys (`created_at` —
 *                     SQL NULL is the correct "missing" contract, no sentinel
 *                     collision); keys PATCHED in place after embed
 *                     (`release_state`/`release_confidence` via
 *                     `patchDomainMetadata` — a column would go stale); and
 *                     LONG-STRING keys (sqlite-vec metadata columns are
 *                     inefficient past ~12 chars).
 *
 * Invariant: a key is in exactly one strategy, and every key here is a
 * `domain_metadata` field. Promoting a key to `'column'` requires it satisfy
 * (a)+(b)+(c) above; when in doubt, `'postKnn'` is always correct (just slower).
 */
export type VectorFilterStrategy = 'partition' | 'column' | 'postKnn';

export interface FilterableKeySpec {
  /** `domain_metadata` key; also the vec0 column/partition name when promoted. */
  readonly key: string;
  readonly strategy: VectorFilterStrategy;
}

export const FILTERABLE_KEY_REGISTRY: readonly FilterableKeySpec[] = [
  { key: 'project_id', strategy: 'partition' },
  // In-KNN columns — equality-only, short, embed-stable.
  { key: 'observation_type', strategy: 'column' },
  { key: 'status', strategy: 'column' },
  { key: 'language', strategy: 'column' },
  // Post-KNN — ranges, patched-in-place, and long strings.
  { key: 'created_at', strategy: 'postKnn' },
  { key: 'release_state', strategy: 'postKnn' },
  { key: 'release_confidence', strategy: 'postKnn' },
  { key: 'release_basis_kind', strategy: 'postKnn' },
  { key: 'release_checked_at', strategy: 'postKnn' },
  { key: 'session_id', strategy: 'postKnn' },
  { key: 'project_root', strategy: 'postKnn' },
  { key: 'name', strategy: 'postKnn' },
  { key: 'source_path', strategy: 'postKnn' },
  { key: 'path', strategy: 'postKnn' },
];

const keysWithStrategy = (s: VectorFilterStrategy): string[] =>
  FILTERABLE_KEY_REGISTRY.filter((k) => k.strategy === s).map((k) => k.key);

/** vec0 partition-key column names (currently just `project_id`). */
export const VECTOR_PARTITION_KEYS: readonly string[] = keysWithStrategy('partition');
/** vec0 metadata-column names, filtered in-KNN. */
export const VECTOR_COLUMN_KEYS: readonly string[] = keysWithStrategy('column');
/** Keys promoted to vec0 (partition + column) — filterable inside the KNN. */
export const VECTOR_INDEXED_KEYS: ReadonlySet<string> = new Set([
  ...VECTOR_PARTITION_KEYS,
  ...VECTOR_COLUMN_KEYS,
]);
/** Every recognized filterable `domain_metadata` key. */
export const FILTERABLE_DOMAIN_KEYS: ReadonlySet<string> = new Set(
  FILTERABLE_KEY_REGISTRY.map((k) => k.key),
);

export interface SemanticSearchFilters {
  status?: string;
  session_id?: string;
  observation_type?: string;
  project_id?: string;
  project_root?: string;
  name?: string;
  source_path?: string;
  release_state?: string;
  release_confidence?: string;
  created_at_gte?: number;
  created_at_lte?: number;
  created_at_gt?: number;
  created_at_lt?: number;
}

export function hasSemanticSearchFilters(filters?: SemanticSearchFilters): boolean {
  if (!filters) return false;
  return Object.values(filters).some(value => value !== undefined);
}

export function matchesSemanticSearchFilters(
  metadata: Partial<EmbeddingMetadata> | undefined,
  filters?: SemanticSearchFilters,
): boolean {
  if (!filters) return true;
  if (filters.status !== undefined && metadata?.status !== filters.status) return false;
  if (filters.session_id !== undefined && metadata?.session_id !== filters.session_id) return false;
  if (filters.observation_type !== undefined && metadata?.observation_type !== filters.observation_type) return false;
  if (filters.project_id !== undefined && metadata?.project_id !== filters.project_id) return false;
  if (filters.project_root !== undefined && metadata?.project_root !== filters.project_root) return false;
  if (filters.name !== undefined && metadata?.name !== filters.name) return false;
  if (filters.source_path !== undefined && metadata?.source_path !== filters.source_path) return false;
  if (filters.release_state !== undefined && metadata?.release_state !== filters.release_state) return false;
  if (filters.release_confidence !== undefined && metadata?.release_confidence !== filters.release_confidence) return false;

  const createdAt = typeof metadata?.created_at === 'number' ? metadata.created_at : undefined;
  if (filters.created_at_gte !== undefined && (createdAt === undefined || createdAt < filters.created_at_gte)) return false;
  if (filters.created_at_lte !== undefined && (createdAt === undefined || createdAt > filters.created_at_lte)) return false;
  if (filters.created_at_gt !== undefined && (createdAt === undefined || createdAt <= filters.created_at_gt)) return false;
  if (filters.created_at_lt !== undefined && (createdAt === undefined || createdAt >= filters.created_at_lt)) return false;

  return true;
}

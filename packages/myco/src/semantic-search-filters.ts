import type { EmbeddingMetadata } from '@myco/daemon/embedding/types.js';

export interface SemanticSearchFilters {
  status?: string;
  session_id?: string;
  observation_type?: string;
  project_root?: string;
  name?: string;
  source_path?: string;
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
  if (filters.project_root !== undefined && metadata?.project_root !== filters.project_root) return false;
  if (filters.name !== undefined && metadata?.name !== filters.name) return false;
  if (filters.source_path !== undefined && metadata?.source_path !== filters.source_path) return false;

  const createdAt = typeof metadata?.created_at === 'number' ? metadata.created_at : undefined;
  if (filters.created_at_gte !== undefined && (createdAt === undefined || createdAt < filters.created_at_gte)) return false;
  if (filters.created_at_lte !== undefined && (createdAt === undefined || createdAt > filters.created_at_lte)) return false;
  if (filters.created_at_gt !== undefined && (createdAt === undefined || createdAt <= filters.created_at_gt)) return false;
  if (filters.created_at_lt !== undefined && (createdAt === undefined || createdAt >= filters.created_at_lt)) return false;

  return true;
}

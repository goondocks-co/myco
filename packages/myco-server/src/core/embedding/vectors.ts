import { sha256Hex } from '../../hash.js';

export const VECTOR_DIMENSIONS = 1536;
export const VECTOR_QUERY_LIMIT = 100;
export const VECTOR_TYPES = ['session', 'spore', 'plan', 'skill'] as const;
export type VectorType = typeof VECTOR_TYPES[number];
export interface VectorScope { projectId: string; modelKey: string }
export interface VectorMetadata {
  type: VectorType;
  record_id: string;
  revision: string;
  status: string;
  session_id: string;
  created_at: number;
  observation_type: string;
  release_state: string;
  release_confidence: string;
}
export const VECTOR_FILTER_KEYS = ['type', 'status', 'session_id', 'created_at', 'observation_type', 'release_state', 'release_confidence'] as const;
export type VectorFilterKey = typeof VECTOR_FILTER_KEYS[number];
export type VectorFilters = Partial<Record<VectorFilterKey, string | { gte?: number; lte?: number }>>;
export interface StoredVector { id: string; values: number[]; metadata: VectorMetadata }
export interface VectorHit { id: string; score: number }
export interface VectorReference { id: string; type: VectorType; recordId: string; revision: string }
export interface VectorQuery { values: number[]; topK: number; minScore?: number; filters?: VectorFilters }

/** Every operation is bound to one project and one embedding model identity. */
export interface VectorStore {
  upsert(scope: VectorScope, vectors: StoredVector[]): Promise<void>;
  query(scope: VectorScope, query: VectorQuery): Promise<VectorHit[]>;
  get(scope: VectorScope, ids: string[]): Promise<StoredVector[]>;
  delete(scope: VectorScope, references: VectorReference[]): Promise<void>;
}

export const vectorNamespace = (scope: VectorScope): Promise<string> => sha256Hex(JSON.stringify([scope.projectId, scope.modelKey]));
export const vectorId = (scope: VectorScope, type: VectorType, id: string, revision: string): Promise<string> =>
  sha256Hex(JSON.stringify([scope.projectId, scope.modelKey, type, id, revision]));

/** Vector IDs bind the complete source identity to the model partition. */
export async function validateStoredVectors(scope: VectorScope, vectors: StoredVector[]): Promise<void> {
  await validateVectorReferences(scope, vectors.map((v) => ({ id: v.id, type: v.metadata.type, recordId: v.metadata.record_id, revision: v.metadata.revision })));
}

export async function validateVectorReferences(scope: VectorScope, references: VectorReference[]): Promise<void> {
  for (const v of references) {
    const expected = await vectorId(scope, v.type, v.recordId, v.revision);
    if (v.id !== expected) throw new Error('vector ID does not match its project, model and source revision');
  }
}

/** Normalized float32 vectors are zero-padded without changing cosine geometry. */
export function normalizedVector(values: readonly number[]): number[] {
  if (values.length === 0 || values.length > VECTOR_DIMENSIONS || values.some((v) => !Number.isFinite(v))) throw new Error(`embedding must contain 1–${VECTOR_DIMENSIONS} finite dimensions`);
  const magnitude = Math.hypot(...values);
  if (magnitude === 0 || !Number.isFinite(magnitude)) throw new Error('embedding must have a finite nonzero magnitude');
  return Array.from({ length: VECTOR_DIMENSIONS }, (_, i) => i < values.length ? Math.fround(values[i]! / magnitude) : 0);
}

export function validateVectorQuery(query: VectorQuery): void {
  if (!Number.isInteger(query.topK) || query.topK < 1 || query.topK > VECTOR_QUERY_LIMIT) throw new Error(`topK must be between 1 and ${VECTOR_QUERY_LIMIT}`);
  if (query.minScore !== undefined && (!Number.isFinite(query.minScore) || query.minScore < -1 || query.minScore > 1)) throw new Error('minimum similarity must be between -1 and 1');
  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (!(VECTOR_FILTER_KEYS as readonly string[]).includes(key)) throw new Error(`unsupported vector filter: ${key}`);
    if (typeof value === 'string') {
      if (key === 'created_at') throw new Error('created_at requires a numeric range');
    } else if (key !== 'created_at' || value === null || typeof value !== 'object' || Object.keys(value).some((k) => k !== 'gte' && k !== 'lte') || Object.values(value).some((v) => !Number.isFinite(v))) {
      throw new Error('invalid vector filter');
    }
  }
}

export function vectorMatches(metadata: VectorMetadata, filters: VectorFilters = {}): boolean {
  return Object.entries(filters).every(([key, value]) => {
    const held = metadata[key as VectorFilterKey];
    return typeof value === 'string' ? held === value : typeof held === 'number'
      && (value.gte === undefined || held >= value.gte) && (value.lte === undefined || held <= value.lte);
  });
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('vector dimensions differ');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa === 0 || bb === 0 ? 0 : Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

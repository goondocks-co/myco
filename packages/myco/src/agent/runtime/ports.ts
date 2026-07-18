/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { EmbeddableTable } from '@myco/db/queries/embeddings.js';

export interface AgentVectorSearchResult {
  id: string;
  namespace: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface AgentEmbeddingMetadata {
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

export interface AgentSemanticSearchPort {
  embedQuery(text: string): Promise<number[] | null>;
  searchVectors(query: number[], options?: {
    namespace?: string;
    limit?: number;
    threshold?: number;
    filters?: Record<string, unknown>;
  }): AgentVectorSearchResult[];
}

export interface AgentEmbeddingWritePort {
  onContentWritten(
    namespace: EmbeddableTable,
    id: string,
    text: string,
    metadata: AgentEmbeddingMetadata,
  ): Promise<void>;
  onStatusChanged(namespace: 'spores', id: string, status: string): void;
  onRemoved(namespace: EmbeddableTable, id: string): void;
}

export interface AgentEmbeddingSimilarityPort {
  pairwiseSimilarity(namespace: string, threshold?: number): Array<{ idA: string; idB: string; similarity: number }>;
}

export interface AgentEmbeddingPort
  extends AgentSemanticSearchPort, AgentEmbeddingWritePort, AgentEmbeddingSimilarityPort {}

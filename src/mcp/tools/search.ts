import type { MycoIndex } from '../../index/sqlite.js';
import { searchFts, type FtsResult } from '../../index/fts.js';
import type { VectorIndex } from '../../index/vectors.js';
import { generateEmbedding } from '../../intelligence/embeddings.js';
import type { LlmBackend } from '../../intelligence/llm.js';

interface SearchInput {
  query: string;
  type?: 'session' | 'plan' | 'memory' | 'all';
  limit?: number;
}

interface SearchResult {
  note_path: string;
  type: string;
  title: string;
  snippet: string;
  score: number;
  frontmatter: Record<string, unknown>;
}

export async function handleMycoSearch(
  index: MycoIndex,
  input: SearchInput,
  vectorIndex?: VectorIndex,
  backend?: LlmBackend,
): Promise<SearchResult[]> {
  const type = input.type === 'all' ? undefined : input.type;
  const limit = input.limit ?? 10;

  // Try vector search first if available
  if (vectorIndex && backend) {
    try {
      const emb = await generateEmbedding(backend, input.query);
      const results = vectorIndex.search(emb.embedding, {
        limit: input.limit ?? 10,
        similarityFloor: 0.7,
        type: type,
      });
      if (results.length > 0) {
        return results.map((r) => {
          const note = index.query({ id: r.id, limit: 1 })[0];
          return {
            note_path: note?.path ?? r.id,
            type: r.metadata.type || note?.type || 'unknown',
            title: note?.title ?? r.id,
            snippet: note?.content?.slice(0, 120) ?? '',
            score: r.similarity,
            frontmatter: note?.frontmatter ?? {},
          };
        }).filter((r) => r.snippet);
      }
    } catch {
      // Fall through to FTS
    }
  }

  const ftsResults = searchFts(index, input.query, { type, limit });

  return ftsResults.map((r) => {
    const note = index.getNoteByPath(r.path);
    return {
      note_path: r.path,
      type: r.type,
      title: r.title,
      snippet: r.snippet,
      score: Math.abs(r.rank),
      frontmatter: note?.frontmatter ?? {},
    };
  });
}

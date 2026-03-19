import type { MycoIndex } from '../../index/sqlite.js';
import { searchFts } from '../../index/fts.js';
import type { VectorIndex } from '../../index/vectors.js';
import { generateEmbedding } from '../../intelligence/embeddings.js';
import type { EmbeddingProvider } from '../../intelligence/llm.js';
import { CONTENT_SNIPPET_CHARS } from '../../constants.js';

interface SearchInput {
  query: string;
  type?: 'session' | 'plan' | 'spore' | 'all';
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
  backend?: EmbeddingProvider,
): Promise<SearchResult[]> {
  const type = input.type === 'all' ? undefined : input.type;
  const limit = input.limit ?? 10;

  // Try vector search first if available
  if (vectorIndex && backend) {
    try {
      const emb = await generateEmbedding(backend, input.query);
      const results = vectorIndex.search(emb.embedding, {
        limit,
        type,
      });
      if (results.length > 0) {
        // Batch-fetch all notes in one query
        const noteMap = new Map(
          index.queryByIds(results.map((r) => r.id)).map((n) => [n.id, n]),
        );
        return results
          .map((r) => {
            const note = noteMap.get(r.id);
            return {
              note_path: note?.path ?? r.id,
              type: r.metadata.type || note?.type || 'unknown',
              title: note?.title ?? r.id,
              snippet: note?.content?.slice(0, CONTENT_SNIPPET_CHARS) ?? '',
              score: r.similarity,
              frontmatter: note?.frontmatter ?? {},
            };
          })
          .filter((r) => r.snippet)
          .filter((r) => {
            const status = (r.frontmatter as Record<string, unknown>).status as string | undefined;
            return status !== 'superseded' && status !== 'archived';
          });
      }
    } catch {
      // Fall through to FTS
    }
  }

  const ftsResults = searchFts(index, input.query, { type, limit });

  return ftsResults
    .map((r) => {
      const note = index.getNoteByPath(r.path);
      return {
        note_path: r.path,
        type: r.type,
        title: r.title,
        snippet: r.snippet,
        score: Math.abs(r.rank),
        frontmatter: note?.frontmatter ?? {},
      };
    })
    .filter((r) => {
      const status = (r.frontmatter as Record<string, unknown>).status as string | undefined;
      return status !== 'superseded' && status !== 'archived';
    });
}

import type { MycoIndex } from '../../index/sqlite.js';
import { searchFts, type FtsResult } from '../../index/fts.js';

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
): Promise<SearchResult[]> {
  const type = input.type === 'all' ? undefined : input.type;
  const limit = input.limit ?? 10;

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

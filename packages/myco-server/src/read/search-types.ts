export const SEARCH_TYPES = ['session', 'spore', 'plan', 'skill', 'prompt', 'response'] as const;
export type SearchType = typeof SEARCH_TYPES[number];
export const SEARCH_API_LIMIT = 20;
export const SEARCH_TOOL_LIMIT = 10;
export const SEARCH_PREVIEW_CHARS = 300;
export const SEARCH_MAX_LIMIT = 100;

export interface SearchOptions {
  query: string;
  type?: string;
  mode?: string;
  limit?: number;
  status?: string;
  session_id?: string;
  observation_type?: string;
  release_state?: string;
  release_confidence?: string;
  since?: number;
  until?: number;
}

export interface SearchResult {
  id: string;
  type: SearchType;
  title: string;
  preview: string;
  score: number;
  session_id?: string;
  prompt_id?: string;
  retrieve?: { tool: string; input: { op: string; id: string } };
  /** Whether the record's source work is released, as the latest release check left it; absent when it has no release state. */
  release?: ReleaseAnnotation;
}

export interface ReleaseAnnotation {
  state: string;
  confidence: string;
  ref: string | null;
  checked_at: number;
}

export interface SearchAnswer {
  results: SearchResult[];
  mode: 'fts' | 'semantic';
  provider_unavailable: boolean;
  coverage: { pending_blobs: number };
}

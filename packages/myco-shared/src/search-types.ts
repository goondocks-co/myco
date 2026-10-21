export const SEARCH_TYPES = ['session', 'spore', 'plan', 'prompt', 'response'] as const;
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
  /** `relevance` (the default): the best matches in one bounded page. `time`: one type's matches oldest first, in pages that continue by `cursor`. */
  order?: string;
  /** The `cursor` an earlier answer to the same search by time returned: the answer then lists the matches after it. */
  cursor?: string;
}

/** The top-level turn a prompt or reply hit belongs to, as the Project's own session records it. */
export interface SearchTurn {
  /** The turn a named-turn read opens: the hit's prompt, or the prompt it steers. */
  prompt_id: string;
  /** The turn's opening text, cut as a turn row's preview is; null for a turn whose text is stored apart. */
  preview: string | null;
  /** The turn's whole text length in characters; null for a turn whose text is stored apart. */
  text_chars: number | null;
  /** The turn's text is stored apart from the turn row. */
  stored: boolean;
}

export interface SearchResult {
  id: string;
  type: SearchType;
  title: string;
  preview: string;
  /** Relevance among the matches of this answer, 1 for its best; a search by time lists them by time, not by this. */
  score: number;
  /** When the hit's own record was created, in epoch milliseconds. */
  created_at: number;
  session_id?: string;
  prompt_id?: string;
  /** Present on prompt and reply hits: the turn the hit opens, or null when its prompt reference names no prompt of this Project's session. */
  turn?: SearchTurn | null;
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
  /** Passed back as `cursor` for the matches that follow these; null when none follow, and always null unless the search is by time. */
  cursor: string | null;
}

/** A result of a search across Projects: a Project's result, with the Project it belongs to. */
export interface SearchAcrossResult extends SearchResult {
  projectId: string;
}

/** A search across Projects: always full text, so `mode` is `fts` and no semantic provider is asked for. */
export interface SearchAcrossAnswer {
  results: SearchAcrossResult[];
  mode: 'fts';
  provider_unavailable: false;
  coverage: { pending_blobs: number };
  cursor: string | null;
}

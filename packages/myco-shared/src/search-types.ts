/** The kinds of record a search answers with. A card is one turn of a conversation. */
export const SEARCH_TYPES = ['session', 'spore', 'plan', 'card'] as const;
export type SearchType = typeof SEARCH_TYPES[number];
export const SEARCH_API_LIMIT = 20;
export const SEARCH_TOOL_LIMIT = 10;
export const SEARCH_PREVIEW_CHARS = 300;
export const SEARCH_MAX_LIMIT = 100;
/** The longest query a search accepts, in characters. */
export const SEARCH_QUERY_MAX_CHARS = 512;
/** The most words a search matches; words in `SEARCH_STOPWORDS` are not counted. */
export const SEARCH_MAX_TERMS = 16;
/**
 * The newest matches a relevance search ranks in one step, shared among the kinds searched. When more match, the answer
 * is `partial` and later pages continue into older matches.
 */
export const SEARCH_WINDOW = 500;
/** How long a search's later pages stay available after its first continuation. */
export const SEARCH_WINDOW_TTL_MS = 15 * 60_000;
/** Common English words a search ignores: they name nothing a record is about. */
export const SEARCH_STOPWORDS: readonly string[] = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were', 'will', 'with',
];

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
  /** The agent of the session a match belongs to, exactly. */
  agent?: string;
  /** The branch of the session a match belongs to, exactly. */
  branch?: string;
  /** `relevance` (the default): the best of the newest matches first. `time`: one type's matches oldest first. Both page by `cursor`. */
  order?: string;
  /** `all` (the default): a match holds every word. `any`: a match holds at least one. */
  match?: string;
  /** The `nextCursor` an earlier answer to the same search returned: the answer then lists the matches after it. */
  cursor?: string;
}

/** The top-level turn a card hit belongs to, as the Project's own session records it. */
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
  /** The record's own line where it has one, otherwise the text around the first word matched. */
  preview: string;
  /** How well the hit matches among this answer's hits, 1 for the best; a search by time lists them by time, not by this. */
  score: number;
  /** When the hit's own record was created, in epoch milliseconds. */
  created_at: number;
  session_id?: string;
  prompt_id?: string;
  /** Present on card hits: the turn the hit opens, or null when its prompt reference names no prompt of this Project's session. */
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
  /** Present when the session state this record follows has moved and is still being carried to it: `state` is what it last carried, not yet current. */
  propagating?: true;
}

/** What a search covered. */
export interface SearchCoverage {
  /** `building` while existing records are still being added to the search index: older records may be missing. */
  state: 'ready' | 'building';
  /** Plan bodies stored apart that the index has not finished reading; `building` until that count is kept. */
  pendingBlobs: number | 'building';
  /** On a partial answer, the time of the oldest record this page's ranking reached, in epoch milliseconds; otherwise null. */
  horizon: number | null;
}

export interface SearchAnswer {
  hits: SearchResult[];
  mode: 'fts' | 'semantic';
  provider_unavailable: boolean;
  coverage: SearchCoverage;
  /** True when older matches exist than the ones this answer ranked; the next page reaches them. */
  partial: boolean;
  /** When the ranking these hits come from was made, in epoch milliseconds. */
  asOf: number;
  /** Passed back as `cursor` for the hits that follow these; null when none follow. A search never counts its matches. */
  nextCursor: string | null;
}

/** A hit of a search across Projects: a Project's hit, with the Project it belongs to. */
export interface SearchAcrossResult extends SearchResult {
  projectId: string;
}

/** A search across Projects: always words alone, so `mode` is `fts` and no semantic provider is asked for. */
export interface SearchAcrossAnswer extends Omit<SearchAnswer, 'hits' | 'mode' | 'provider_unavailable'> {
  hits: SearchAcrossResult[];
  mode: 'fts';
  provider_unavailable: false;
}

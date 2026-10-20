import { useQueries } from '@tanstack/react-query';
import { SEARCH_MIN_CHARS, SEARCH_RESULT_CAP, useSearch, type SearchResult } from './use-search';
import { namedTurnQuery, type TurnRow } from './use-sessions';

/** The kinds of record a conversation holds in words: tool calls are never searched. */
const CONVERSATION_TYPES = ['prompt', 'response'] as const;

/** What a hit's turn lookup found. */
export type TurnLookup =
  /** The hit names no prompt. */
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'failed' }
  /** The session holds no prompt of that id. */
  | { state: 'missing' }
  | { state: 'found'; turn: TurnRow };

export interface ConversationHit {
  /** Unique among the hits. */
  key: string;
  type: (typeof CONVERSATION_TYPES)[number];
  preview: string;
  /** The prompt the hit belongs to, or null. */
  promptId: string | null;
  lookup: TurnLookup;
}

/**
 * Prompt and reply hits of one session, from the project's own search scoped to the session, by words: a search by
 * meaning reads only the records already embedded, so it would leave out the newest turns. The turn each hit
 * belongs to is read through the same bounded lookup `?turn=` opens. The search has no continuation: `capped` says a
 * kind returned as many as it will.
 */
export function useConversationSearch(projectId: string, sessionId: string, query: string) {
  const enabled = query.length >= SEARCH_MIN_CHARS;
  const prompts = useSearch({ projectId }, { query, type: CONVERSATION_TYPES[0], since: '', observationType: '', sessionId, mode: 'fts' }, enabled);
  const replies = useSearch({ projectId }, { query, type: CONVERSATION_TYPES[1], since: '', observationType: '', sessionId, mode: 'fts' }, enabled);
  const found: SearchResult[] = [...(prompts.data?.results ?? []), ...(replies.data?.results ?? [])]
    .filter((hit) => hit.type === 'prompt' || hit.type === 'response')
    .sort((a, b) => b.score - a.score || CONVERSATION_TYPES.indexOf(a.type as 'prompt') - CONVERSATION_TYPES.indexOf(b.type as 'prompt') || a.id.localeCompare(b.id));
  const promptIds = [...new Set(found.flatMap((hit) => hit.prompt_id === undefined ? [] : [hit.prompt_id]))];
  const turns = useQueries({ queries: promptIds.map((id) => namedTurnQuery(projectId, sessionId, id)) });
  const lookups = new Map<string, TurnLookup>(promptIds.map((id, index) => {
    const read = turns[index]!;
    if (read.isError) return [id, { state: 'failed' }];
    if (read.data === undefined) return [id, { state: 'pending' }];
    const turn = read.data.rows[0];
    return [id, turn === undefined ? { state: 'missing' } : { state: 'found', turn }];
  }));
  const hits: ConversationHit[] = found.map((hit) => ({
    key: `${hit.type}:${hit.id}`,
    type: hit.type as ConversationHit['type'],
    preview: hit.preview,
    promptId: hit.prompt_id ?? null,
    lookup: hit.prompt_id === undefined ? { state: 'none' } : lookups.get(hit.prompt_id)!,
  }));
  const reads = [prompts, replies];
  return {
    hits,
    enabled,
    isPending: enabled && (reads.some((read) => read.isPending) || hits.some((hit) => hit.lookup.state === 'pending')),
    error: prompts.error ?? replies.error,
    retry: () => { for (const read of reads) if (read.isError) void read.refetch(); },
    capped: reads.some((read) => (read.data?.results.length ?? 0) >= SEARCH_RESULT_CAP),
    pendingBodies: Math.max(...reads.map((read) => read.data?.coverage.pending_blobs ?? 0)),
  };
}

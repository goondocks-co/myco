import { FilterBar, useFilterParams, useQueryDraft } from '../../design';
import { useConversationSearch, type ConversationHit } from '../../hooks/use-conversation-search';
import { SEARCH_MIN_CHARS } from '../../hooks/use-search';
import { SessionEventList, type SessionEventRow } from './SessionEventList';
import { promptPreview } from './Turn';

const SEARCH_DEBOUNCE_MS = 250;
const TYPE_WORD: Record<ConversationHit['type'], string> = { prompt: 'Prompt', response: 'Reply' };

/** The conversation's search, held in the URL as `?q=`; `query` is what is being searched, trimmed. */
export function useConversationQuery() {
  const params = useFilterParams([]);
  const draft = useQueryDraft(params.query, params.setQuery, SEARCH_DEBOUNCE_MS);
  return { params, draft, query: params.query.trim() };
}

export type ConversationQuery = ReturnType<typeof useConversationQuery>;

export function ConversationSearchBar({ search }: { search: ConversationQuery }) {
  const { params, draft } = search;
  return (
    <FilterBar
      searchLabel="Search the conversation"
      placeholder="Search what was said"
      query={draft.text}
      onQueryChange={draft.setText}
      onClear={() => { draft.reset(); params.clear(); }}
    />
  );
}

/** One hit as a row: the turn it belongs to opens through `?turn=`; a hit with no turn in this session leads nowhere. */
function hitRow(hit: ConversationHit, agent: string | null): SessionEventRow {
  const found = hit.lookup.state === 'found' ? hit.lookup.turn : null;
  const detail = hit.lookup.state === 'failed' ? 'The turn could not be read'
    : found === null ? 'Not tied to a prompt'
    : hit.type === 'response' ? `In reply to “${promptPreview(found, agent)}”` : 'The prompt of this turn';
  return {
    key: hit.key,
    at: found?.createdAt ?? null,
    kind: TYPE_WORD[hit.type],
    title: hit.preview === '' ? 'Matched inside a long message' : hit.preview,
    detail,
    to: found === null || hit.promptId === null ? undefined : `?${new URLSearchParams({ turn: hit.promptId })}`,
  };
}

/** What a query found in the whole session's prompts and replies; tool calls are not searched. */
export function ConversationHits({ projectId, sessionId, agent, query, now }: { projectId: string; sessionId: string; agent: string | null; query: string; now: number }) {
  const found = useConversationSearch(projectId, sessionId, query);
  if (!found.enabled) return <p role="status" className="t-small text-muted">Search starts at {SEARCH_MIN_CHARS} characters.</p>;
  return (
    <div className="flex flex-col gap-s3">
      <SessionEventList
        read={{
          rows: found.hits.map((hit) => hitRow(hit, agent)),
          isPending: found.isPending,
          error: found.error,
          retry: found.retry,
          hasMore: false,
          isFetchingMore: false,
          more: () => undefined,
        }}
        noun="matches"
        wrap
        emptyTitle={`Nothing said in this session matches “${query}”.`}
        loadingLabel="Searching the conversation"
        now={now}
      />
      {!found.isPending && found.pendingBodies > 0 && (
        <p className="t-small text-muted">Indexing {found.pendingBodies} captured bodies. More matches will become available.</p>
      )}
      {!found.isPending && !found.error && found.capped && (
        <p className="t-small text-muted">These are the best matches. Add a word to narrow the search.</p>
      )}
    </div>
  );
}

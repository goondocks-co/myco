import { useFilterParams, useQueryDraft } from '../../design';

const SEARCH_DEBOUNCE_MS = 250;

/** The conversation's search, held in the URL as `?q=`; `query` is what is being searched, trimmed. */
export function useConversationQuery() {
  const params = useFilterParams([]);
  const draft = useQueryDraft(params.query, params.setQuery, SEARCH_DEBOUNCE_MS);
  return { params, draft, query: params.query.trim() };
}

export type ConversationQuery = ReturnType<typeof useConversationQuery>;

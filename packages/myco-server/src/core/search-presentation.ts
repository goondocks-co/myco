import type { SearchResult, SearchType } from '@goondocks/myco-shared/search-types';

/** A search pointer opens the same entity or turn that supplied the hit. */
export function searchPresentation(record: {
  type: SearchType; id: string; status: string; learnedAt: number; successorId?: string | null;
  sessionId: string | null; promptId: string | null;
}): Pick<SearchResult, 'status' | 'learned_at' | 'successor_id' | 'retrieve'> {
  const { type, id, sessionId, promptId } = record;
  const tool = type === 'spore' ? 'myco_spores' : type === 'plan' ? 'myco_plans' : 'myco_sessions';
  return {
    status: record.status, learned_at: new Date(record.learnedAt).toISOString(),
    ...(record.successorId == null ? {} : { successor_id: record.successorId }),
    ...(type === 'card' && sessionId === null ? {} : { retrieve: {
      tool, input: { op: 'get', id: type === 'card' ? sessionId! : id,
        ...(type === 'card' && promptId !== null ? { prompt_id: promptId } : {}) },
    } }),
  };
}

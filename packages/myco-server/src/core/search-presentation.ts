import type { SearchResult, SearchType } from '@goondocks/myco-shared/search-types';

/** A search pointer opens the same entity or turn that supplied the hit. */
export function searchPresentation(record: {
  type: SearchType; id: string; status: string; learnedAt: number; successorId?: string | null; successorIds?: readonly string[];
  sessionId: string | null; promptId: string | null;
}): Pick<SearchResult, 'status' | 'learned_at' | 'successor_id' | 'successor_ids' | 'retrieve'> {
  const { type, id, sessionId, promptId } = record;
  const successor = record.successorIds === undefined ? record.successorId : record.successorIds.length === 1 ? record.successorIds[0] : null;
  const tool = type === 'spore' ? 'myco_spores' : type === 'plan' ? 'myco_plans' : 'myco_sessions';
  return {
    status: record.status, learned_at: new Date(record.learnedAt).toISOString(),
    ...(successor == null ? {} : { successor_id: successor }),
    ...(record.successorIds !== undefined && record.successorIds.length > 1 ? { successor_ids: [...record.successorIds] } : {}),
    ...(type === 'card' && sessionId === null ? {} : { retrieve: {
      tool, input: { op: 'get', id: type === 'card' ? sessionId! : id,
        ...(type === 'card' && promptId !== null ? { prompt_id: promptId } : {}) },
    } }),
  };
}

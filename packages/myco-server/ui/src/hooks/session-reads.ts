import type { QueryClient } from '@tanstack/react-query';

/** Session-bound reads whose payload changes with the session's receive revision. */
export const SESSION_READS = ['conversation-search', 'turns', 'turn', 'turn-tool-calls', 'session-commits', 'session-activity', 'session-artifacts', 'session-files', 'session-children', 'session-lineage', 'transcript'] as const;

export function invalidateSessionReads(client: QueryClient, projectId: string, sessionId: string) {
  return Promise.all([
    ...SESSION_READS.map(read => client.invalidateQueries({ queryKey: [read, projectId, sessionId] })),
    ...['spores', 'search'].map(read => client.invalidateQueries({ queryKey: [read, projectId] })),
  ]);
}

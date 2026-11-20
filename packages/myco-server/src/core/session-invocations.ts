import type { RelationalStore } from './adapters.js';

/** An authoritative invocation covers source instants in [from, until), within one Project and session. */
export interface SessionInvocation {
  from: number;
  until: number;
  origin: 'user' | 'agent_dispatch';
  parentSessionId?: string;
}

/** Returns non-overlapping invocation facts intersecting this source-time window; an absent fact supplies no attribution. */
export async function sessionInvocationFacts(_db: RelationalStore,
  _window: { projectId: string; sessionId: string; from: number; until: number }): Promise<readonly SessionInvocation[]> {
  return [];
}

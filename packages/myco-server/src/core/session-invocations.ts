import type { RelationalStore } from './adapters.js';

/** An authoritative invocation covers source instants in [from, until), within one Project and session. */
export interface SessionInvocation {
  from: number;
  until: number;
  origin: 'user' | 'agent_dispatch';
  parentSessionId?: string;
}

/** Native harness origins stand; invocation facts override the session's launch default for instructions. */
export function attributedPrompt(payload: Record<string, unknown>, context: {
  at: number; launchParentSessionId?: string; invocations?: readonly SessionInvocation[];
}): Record<string, unknown> {
  if (payload.origin !== 'user') return payload;
  const matched = context.invocations?.filter(fact => fact.from <= context.at && context.at < fact.until) ?? [];
  if (matched.length > 1) throw new Error('session_invocation_overlap');
  const origin = matched[0]?.origin ?? (context.launchParentSessionId === undefined ? 'user' : 'agent_dispatch');
  const parent = matched[0]?.parentSessionId ?? (matched.length === 0 ? context.launchParentSessionId : undefined);
  return { ...payload, origin, originSessionId: origin === 'agent_dispatch' ? parent : undefined };
}

/** Returns non-overlapping invocation facts intersecting this source-time window; an absent fact supplies no attribution. */
export async function sessionInvocationFacts(_db: RelationalStore,
  _window: { projectId: string; sessionId: string; from: number; until: number }): Promise<readonly SessionInvocation[]> {
  return [];
}

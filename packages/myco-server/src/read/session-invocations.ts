import { sessionTurnInvocationFacts } from '../db/telemetry/invocations.js';
import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

export const INVOCATION_START_TOLERANCE_MS = 2_000;

export interface SessionInvocation {
  startAt: number;
  endAt: number | null;
  matchedBy: 'exact' | 'inferred';
  keyLabel: string | null;
  serviceName: string | null;
  agentName: string | null;
}

export type InvocationProvider = (db: RelationalStore, scope: ReadScope, sessionId: string) => Promise<readonly SessionInvocation[]>;

/** Invocation facts are display evidence and may arrive after transcript publication. */
export const sessionInvocationFacts: InvocationProvider = (db,scope,sessionId) => sessionTurnInvocationFacts(db,{projectId:scope.projectId,sessionId,tolerance:INVOCATION_START_TOLERANCE_MS});

/** Only one invocation starting near a turn head supplies display attribution. */
export async function sessionTurnInvocations(db: RelationalStore, scope: ReadScope, sessionId: string,
  provider: InvocationProvider = sessionInvocationFacts) {
  const facts = await provider(db, scope, sessionId);
  const show = <T extends { createdAt: number; origin: string }>(turn: T) => {
    const matches = facts.filter(fact => Math.abs(fact.startAt - turn.createdAt) <= INVOCATION_START_TOLERANCE_MS);
    return matches.length === 1 ? { ...turn, origin: 'agent_dispatch', invocation: matches[0]! } : turn;
  };
  return {
    active: facts.length > 0,
    show,
    window: { starts: facts.map(fact => fact.startAt), tolerance: INVOCATION_START_TOLERANCE_MS },
    invokedPersonTurns(heads: readonly { createdAt: number; origin: string }[]): number {
      return heads.filter(head => head.origin === 'user' && show(head).origin !== 'user').length;
    },
  };
}

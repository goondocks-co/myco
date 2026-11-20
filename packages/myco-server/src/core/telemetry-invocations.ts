import type { RelationalStore } from './adapters.js';
import { invocationRows, type InvocationFact } from '../db/telemetry/invocations.js';
import { TELEMETRY_CLOCK_TOLERANCE_MS, TELEMETRY_INVOCATIONS_PER_PAGE } from './telemetry-policy.js';

export type { InvocationFact } from '../db/telemetry/invocations.js';
export interface InvocationCursor {
  startAt: number;
  traceId: string;
  spanId: string;
}

/**
 * A Project-scoped page of stored invocation facts, ordered by (startAt, traceId, spanId).
 * Times are sender epoch milliseconds. Follow nextCursor until null; a revoked key contributes no facts.
 * A fact says a program invoked the session; it never identifies a person or changes captured turn content.
 */
export async function invocationsForSession(
  db: RelationalStore,
  projectId: string,
  sessionId: string,
  cursor?: InvocationCursor,
): Promise<{ rows: InvocationFact[]; nextCursor: InvocationCursor | null }> {
  const facts = await invocationRows(db, {
    projectId,
    sessionId,
    after: cursor?.startAt ?? -1,
    trace: cursor?.traceId ?? '',
    span: cursor?.spanId ?? '',
    limit: TELEMETRY_INVOCATIONS_PER_PAGE + 1,
  });
  const rows = facts.slice(0, TELEMETRY_INVOCATIONS_PER_PAGE),
    last = rows.at(-1);
  return {
    rows,
    nextCursor:
      facts.length > TELEMETRY_INVOCATIONS_PER_PAGE && last !== undefined
        ? { startAt: last.startAt, traceId: last.traceId, spanId: last.spanId }
        : null,
  };
}

/** Only a turn starting within clock tolerance of a single invocation is attributed. */
export function invocationForTurn(
  facts: readonly InvocationFact[],
  turn: { startAt: number; endAt: number },
): InvocationFact | null {
  if (!Number.isFinite(turn.startAt) || !Number.isFinite(turn.endAt) || turn.endAt < turn.startAt) return null;
  const candidates = facts.filter((fact) => Math.abs(fact.startAt - turn.startAt) <= TELEMETRY_CLOCK_TOLERANCE_MS);
  return candidates.length === 1 ? candidates[0]! : null;
}

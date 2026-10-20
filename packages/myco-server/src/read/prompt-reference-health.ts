import type { RelationalStore } from '../core/adapters.js';
import { danglingPromptReferences, promptKeyMismatches } from './prompt-reference-invariant.js';

/** References and asks from the last seven days contribute to prompt identity attention and operator status. */
export const PROMPT_REFERENCE_LOOKBACK_DAYS = 7;
export const PROMPT_REFERENCE_LOOKBACK_MS = PROMPT_REFERENCE_LOOKBACK_DAYS * 86_400_000;

export interface PromptAskIdentity {
  agent: string;
  asks: number;
  sessionScoped: number;
  scopeReasons: Record<string, { asks: number; share: number }>;
  legacy: number;
  sessionScopedShare: number | null;
  legacyShare: number | null;
  keyMismatches: number;
}

/** Each answer records one ask; selections and delivery of the same ask are not additional samples. */
const PROMPT_ASK_IDENTITY_SQL = `SELECT COALESCE(s.agent, '') AS agent, a.scope_reason AS reason,
    COUNT(*) AS asks, SUM(a.ask_protocol = 'legacy') AS legacy
  FROM projects pr CROSS JOIN prompt_context_answers a
    LEFT JOIN sessions s ON s.project_id = a.project_id AND s.session_id = a.session_id
  WHERE a.project_id = pr.project_id AND a.created_at >= ?
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = a.project_id AND t.session_id = a.session_id)
  GROUP BY s.agent, a.scope_reason`;

/** The same reference counts and window for Needs you and both operator status targets. */
export async function readPromptReferenceCounts(db: RelationalStore, now: number) {
  const since = now - PROMPT_REFERENCE_LOOKBACK_MS;
  const dangling = await danglingPromptReferences(db, since);
  return { since, dangling, total: Object.values(dangling).reduce((sum, n) => sum + n, 0) };
}

/** Mismatches raise attention; session-scoped and legacy ask shares only describe its sample. */
export async function readPromptReferenceHealth(db: RelationalStore, now: number) {
  const since = now - PROMPT_REFERENCE_LOOKBACK_MS;
  const [counts, mismatches, rows] = await Promise.all([
    readPromptReferenceCounts(db, now),
    promptKeyMismatches(db, since),
    db.prepare(PROMPT_ASK_IDENTITY_SQL).bind(since).all<{ agent: string; reason: string | null; asks: number; legacy: number }>(),
  ]);
  const byAgent = new Map<string, PromptAskIdentity>();
  const of = (agent: string): PromptAskIdentity => {
    let identity = byAgent.get(agent);
    if (identity === undefined) {
      identity = { agent, asks: 0, sessionScoped: 0, scopeReasons: {}, legacy: 0, sessionScopedShare: null, legacyShare: null, keyMismatches: 0 };
      byAgent.set(agent, identity);
    }
    return identity;
  };
  for (const row of rows.results) {
    const identity = of(row.agent);
    identity.asks += row.asks;
    identity.legacy += row.legacy;
    if (row.reason !== null) {
      identity.sessionScoped += row.asks;
      identity.scopeReasons[row.reason] = { asks: row.asks, share: 0 };
    }
  }
  for (const [agent, n] of Object.entries(mismatches)) of(agent).keyMismatches = n;
  for (const identity of byAgent.values()) {
    for (const reason of Object.values(identity.scopeReasons)) reason.share = reason.asks / identity.asks;
    identity.sessionScopedShare = identity.asks === 0 ? null : identity.sessionScoped / identity.asks;
    identity.legacyShare = identity.asks === 0 ? null : identity.legacy / identity.asks;
  }
  return { ...counts, agents: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent)) };
}

export type PromptReferenceHealth = Awaited<ReturnType<typeof readPromptReferenceHealth>>;

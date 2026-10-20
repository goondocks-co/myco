import { PROMPT_SCOPE_REASONS, type PromptScopeReason } from '@goondocks/myco-shared/prompt-identity';
import type { RelationalStore } from '../core/adapters.js';
import { danglingPromptReferences, promptKeyMismatches } from './prompt-reference-invariant.js';

/** References and asks from the last seven days contribute to prompt identity attention and operator status. */
export const PROMPT_REFERENCE_LOOKBACK_DAYS = 7;
export const PROMPT_REFERENCE_LOOKBACK_MS = PROMPT_REFERENCE_LOOKBACK_DAYS * 86_400_000;

export interface PromptAskIdentity {
  agent: string;
  asks: number;
  sessionScoped: number;
  scopeReasons: Partial<Record<PromptScopeReason, { asks: number; share: number }>>;
  legacy: number;
  sessionScopedShare: number | null;
  legacyShare: number | null;
  keyMismatches: number;
}

/** Dated asks share a session and ask instant; an undated answer remains its own sample. */
const ASK_ID = `CASE WHEN a.asked_at IS NULL THEN json_array(a.project_id, a.id)
  ELSE json_array(a.project_id, a.session_id, a.asked_at) END`;
const distinctAsks = (condition: string) => `COUNT(DISTINCT CASE WHEN ${condition} THEN ${ASK_ID} END)`;
const PROMPT_ASK_IDENTITY_SQL = `SELECT COALESCE(s.agent, '') AS agent,
    ${distinctAsks('1 = 1')} AS asks,
    ${distinctAsks("a.ask_protocol = 'legacy'")} AS legacy,
    ${distinctAsks('a.scope_reason IS NOT NULL')} AS scoped,
    ${PROMPT_SCOPE_REASONS.map(reason => `${distinctAsks(`a.scope_reason = '${reason}'`)} AS ${reason}`).join(', ')}
  FROM projects pr CROSS JOIN prompt_context_answers a
    LEFT JOIN sessions s ON s.project_id = a.project_id AND s.session_id = a.session_id
  WHERE a.project_id = pr.project_id AND a.created_at >= ?
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = a.project_id AND t.session_id = a.session_id)
  GROUP BY s.agent`;

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
    db.prepare(PROMPT_ASK_IDENTITY_SQL).bind(since).all<{ agent: string; asks: number; legacy: number; scoped: number } & Record<PromptScopeReason, number>>(),
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
    identity.asks = row.asks;
    identity.legacy = row.legacy;
    identity.sessionScoped = row.scoped;
    for (const reason of PROMPT_SCOPE_REASONS) {
      if (row[reason] > 0) identity.scopeReasons[reason] = { asks: row[reason], share: row[reason] / row.asks };
    }
  }
  for (const [agent, n] of Object.entries(mismatches)) of(agent).keyMismatches = n;
  for (const identity of byAgent.values()) {
    identity.sessionScopedShare = identity.asks === 0 ? null : identity.sessionScoped / identity.asks;
    identity.legacyShare = identity.asks === 0 ? null : identity.legacy / identity.asks;
  }
  return { ...counts, agents: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent)) };
}

export type PromptReferenceHealth = Awaited<ReturnType<typeof readPromptReferenceHealth>>;

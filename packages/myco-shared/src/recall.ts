/** The identity of one session-context request, independent of transport and storage. */
export type SessionContextIdentity = (
  | { kind: 'start' | 'subagent' }
  | { kind: 'compact'; compaction: number }
) & { agentId?: string; agentType?: string };

export type SessionContextRequest = SessionContextIdentity & { sessionId: string };

const MAX_AGENT_CHARS = 192;

export const isCompactionOrdinal = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Optional delegation identifiers must be nonempty strings within the wire limit. */
const validAgent = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= MAX_AGENT_CHARS);

export function parseSessionContextIdentity(body: Record<string, unknown>): SessionContextIdentity | null {
  if (!validAgent(body.agentId) || !validAgent(body.agentType)) return null;
  const agent = { agentId: body.agentId, agentType: body.agentType };
  if (body.kind === 'start' || body.kind === 'subagent') return { kind: body.kind, ...agent };
  if (body.kind === 'compact' && isCompactionOrdinal(body.compaction)) return { kind: 'compact', compaction: body.compaction, ...agent };
  return null;
}

/** The member cache and server receipt use the same disjoint identity namespaces. */
export function sessionInjectionKind(identity: SessionContextIdentity): string {
  if (identity.kind === 'start') return 'cortex';
  if (identity.kind === 'compact') {
    if (!isCompactionOrdinal(identity.compaction)) throw new Error('compaction must be a positive safe integer');
    return `cortex-compact:${identity.compaction}`;
  }
  return `cortex:${identity.agentId?.trim() || identity.agentType?.trim() || 'unknown'}`;
}

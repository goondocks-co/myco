/** The identity of one session-context request, independent of transport and storage. */
export type SessionContextIdentity = (
  | { kind: 'start' | 'subagent' }
  | { kind: 'compact'; compaction: number }
) & { agentId?: string; agentType?: string };

export type SessionContextRequest = SessionContextIdentity & {
  sessionId: string;
  /**
   * The repository's normalized-able git remote, sent at session start so the
   * Deployment can bind it to this Project. A tool call may then name the
   * Project by the remote an agent can read off the checkout, rather than by an
   * id it has no way to know.
   */
  remote?: string;
};

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

/** The blank line between two parts of one served block. */
export const BLOCK_JOIN = '\n\n';

const PROJECT_LINE_PREFIX = 'Project:: ';

/**
 * The Project a session works in, told to the agent in the words the tool surface uses for it. An agent that reads
 * this line can name its Project on a write, which the tool surface requires of one. The Deployment puts it first in
 * every session block it composes, and a member writes it itself above a block it renders from its cache, so a session
 * is told its Project whether or not anything is cached yet.
 */
export const projectLine = (projectId: string): string =>
  `${PROJECT_LINE_PREFIX}\`${projectId}\` — pass this as \`project\` on Myco tool calls; a write without it is refused.`;

/** A composed session block without the Project line it starts with: what a member renders under its own. */
export function withoutProjectLine(block: string): string {
  const parts = block.split(BLOCK_JOIN);
  return (parts[0]?.startsWith(PROJECT_LINE_PREFIX) ? parts.slice(1) : parts).join(BLOCK_JOIN).trim();
}

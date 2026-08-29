/**
 * `myco_cortex` over the Deployment's generated intelligence: the digest
 * tiers, the current instructions, and the activity of every Project.
 *
 * The Canopy, notification and maintenance ops are named in the registry as
 * not yet served; nothing here answers them.
 */
import { listDigests, type DigestRow } from '../../core/digests.js';
import { listInstructions } from '../../read/cortex.js';
import { listProjects } from '../../read/sessions.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export const DEFAULT_TIER = 5000;
export const NO_DIGEST_MESSAGE = 'Digest context is not yet available. The first digest cycle has not completed.';
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DigestResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated_at?: number;
}

/** The newest digest of each tier, whichever agent produced it. */
function newestPerTier(rows: readonly DigestRow[]): DigestRow[] {
  const byTier = new Map<number, DigestRow>();
  for (const row of rows) {
    const held = byTier.get(row.tier);
    if (held === undefined || row.generatedAt > held.generatedAt) byTier.set(row.tier, row);
  }
  return [...byTier.values()];
}

export async function handleCortexDigest(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const requested = typeof input.tier === 'number' ? input.tier : DEFAULT_TIER;
  const tiers = newestPerTier(await listDigests(ctx.env.db, scope));
  if (tiers.length === 0) return { content: NO_DIGEST_MESSAGE, tier: requested, fallback: false } satisfies DigestResult;
  const exact = tiers.find((t) => t.tier === requested);
  if (exact) return { content: exact.content, tier: exact.tier, fallback: false, generated_at: exact.generatedAt } satisfies DigestResult;
  const nearest = [...tiers].sort((a, b) => Math.abs(a.tier - requested) - Math.abs(b.tier - requested))[0];
  return { content: nearest.content, tier: nearest.tier, fallback: true, generated_at: nearest.generatedAt } satisfies DigestResult;
}

export async function handleCortexInstructions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const [newest] = await listInstructions(ctx.env.db, scope);
  if (newest === undefined) return failure('Cortex instructions not available');
  return { content: newest.content, agent_id: newest.agentId, generated_at: newest.generatedAt, input_hash: newest.inputHash };
}

/** Every Project of the Deployment with its last activity; `active` when something arrived in the last seven days. */
export async function handleCortexProjectsActivity(_input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const projects = await listProjects(ctx.env.db);
  return {
    projects: projects.map((p) => ({
      id: p.projectId,
      name: p.name,
      session_count: p.sessionCount,
      last_activity_at: p.lastActivityAt,
      active: p.lastActivityAt !== null && ctx.now - p.lastActivityAt <= ACTIVE_WINDOW_MS,
    })),
  };
}

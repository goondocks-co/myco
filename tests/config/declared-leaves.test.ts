/**
 * The declared-leaf walker (#915 L0/L3).
 *
 * It exists because a defaulted parse cannot see an `.optional()` leaf, and the
 * optional ones are the endpoints a Deployment's credential is sent to. Its own
 * failure mode is the same shape: a schema construct it does not recognise would
 * collapse a whole subtree to one path, and the coverage gate cannot tell that
 * from a legitimate dynamic block.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { declaredLeafPaths } from '../../packages/myco/src/config/declared-leaves';
import { enumerateLeafPaths } from '../../packages/myco/src/config/leaf-paths';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('declared leaves', () => {
  it('is a strict superset of what a defaulted parse can see', () => {
    const declared = new Set(declaredLeafPaths());
    const defaulted = enumerateLeafPaths(MycoConfigSchema.parse({ version: 3 }) as Record<string, unknown>);
    for (const leaf of defaulted) expect({ leaf, declared: declared.has(leaf) }).toEqual({ leaf, declared: true });
    expect(declared.size).toBeGreaterThan(defaulted.length);
  });

  it('reaches the optional leaves that name an endpoint — the ones this exists for', () => {
    const declared = declaredLeafPaths();
    for (const leaf of ['agent.provider.base_url', 'agent.provider.type', 'embedding.base_url']) {
      expect({ leaf, found: declared.includes(leaf) }).toEqual({ leaf, found: true });
    }
  });

  it('treats a union as one setting rather than inventing paths for its branches', () => {
    // `thinking_budget_map.low` is `{budgetTokens} | {adaptive}` — a single value an
    // operator sets, not two independent settings.
    expect(declaredLeafPaths()).toContain('agent.provider.thinking_budget_map.low');
  });
});

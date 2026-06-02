import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import { scopePolicyForPath } from '../../packages/myco/src/config/scope';
import { enumerateLeafPaths } from '../../packages/myco/src/config/leaf-paths';
import { SETTINGS_GROUPS } from '../../packages/myco/ui/src/settings/manifest';

// Dynamic records/arrays are covered by their block-prefix entry; their dynamic
// children are not enumerable from a defaulted schema, so they are skipped here.
const COVERAGE_IGNORE = ['agent.tasks', 'notifications.domains', 'symbionts', 'release_provenance.package_map'];

describe('scope registry sync', () => {
  it('every schema leaf is covered by exactly one registry prefix', () => {
    const merged = MycoConfigSchema.parse({ version: 3 }) as Record<string, unknown>;
    const errors: string[] = [];
    for (const leaf of enumerateLeafPaths(merged)) {
      if (COVERAGE_IGNORE.some((p) => leaf === p || leaf.startsWith(`${p}.`))) continue;
      try { scopePolicyForPath(leaf); } catch { errors.push(leaf); }
    }
    if (errors.length) throw new Error(`Schema leaves with no registry entry:\n  ${errors.join('\n  ')}`);
  });

  it('manifest scope matches the registry home (local renders as Personal)', () => {
    const errors: string[] = [];
    for (const g of SETTINGS_GROUPS) for (const f of g.fields) {
      let policy; try { policy = scopePolicyForPath(f.key); } catch { errors.push(`${f.key}: no registry entry`); continue; }
      if (f.scope !== policy.home) errors.push(`${f.key}: manifest scope '${f.scope}' != registry home '${policy.home}'`);
    }
    if (errors.length) throw new Error(`Manifest/registry drift:\n  ${errors.join('\n  ')}`);
  });
});

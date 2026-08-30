/**
 * The dashboard's settings catalogue and the server's Deployment leaf list are
 * one set. A leaf added on one side without the other fails here by name: the
 * server would accept a value the dashboard cannot edit, or the dashboard would
 * offer a control the server refuses as not its tier.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENT_LEAVES } from '@myco-server-worker/core/settings.js';
import { LEAF_FIELDS, LEAF_GROUPS } from '../../packages/myco-server/ui/src/settings/catalogue.js';

function walkSources(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...walkSources(path));
    else if (/\.(ts|tsx|css|html|md)$/.test(name)) out.push(path);
  }
  return out;
}

describe('settings catalogue', () => {
  it('names every Deployment leaf exactly once, and nothing else', () => {
    const catalogued = LEAF_FIELDS.map((f) => f.leaf);
    expect(new Set(catalogued).size).toBe(catalogued.length);
    expect([...catalogued].sort()).toEqual([...DEPLOYMENT_LEAVES].sort());
  });

  it('names no retired mechanism anywhere a person or a handler reads', () => {
    // The step-up credential left the product (#1036); the words must not come
    // back through a note, a refusal string, or a helper. The schema alone keeps
    // the dormant table's chain history.
    const offenders: string[] = [];
    for (const root of ['packages/myco-server/src', 'packages/myco-server/ui/src', 'packages/myco-server/scripts', 'packages/myco-server/BREAK-GLASS.md', 'packages/myco-server/README.md', 'packages/myco-server/smoke.md']) {
      for (const file of walkSources(root)) {
        if (/step[ -_]?up/i.test(readFileSync(file, 'utf8').replace(/step_up_authorities/g, ''))) offenders.push(file);
      }
    }
    // The retirement note and the dormant table's chain history may say the name; nothing else may.
    expect(offenders.sort()).toEqual(['packages/myco-server/BREAK-GLASS.md', 'packages/myco-server/src/db/schema.ts']);
  });

  it('gives every select its options and every group a note', () => {
    for (const field of LEAF_FIELDS) {
      if (field.kind === 'select') expect({ leaf: field.leaf, options: (field.options ?? []).length > 0 }).toEqual({ leaf: field.leaf, options: true });
    }
    for (const group of LEAF_GROUPS) expect({ group: group.id, note: group.note.length > 0 }).toEqual({ group: group.id, note: true });
  });
});

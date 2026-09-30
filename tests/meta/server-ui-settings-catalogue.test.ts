/**
 * The dashboard's settings catalogue and the server's Deployment leaf list are
 * one set. A leaf added on one side without the other fails here by name: the
 * server would accept a value the dashboard cannot edit, or the dashboard would
 * offer a control the server refuses as not its tier.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '@myco-server-worker/core/settings.js';
import { LEAF_FIELDS, LEAF_GROUPS, LIVE_FIELDS } from '../../packages/myco-server/ui/src/features/admin/settings/catalogue.js';
import { LEAF_DEFAULTS } from '../../packages/myco-server/ui/src/features/admin/settings/defaults.js';

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

  /**
   * A catalogue entry and a render arm are two halves of one control.
   * `LeafControl.tsx` renders per `kind`, so a kind named here with no arm there
   * yields a leaf with a label, a note and no input — which reads as a rendered
   * control until someone tries to type in it.
   */
  it('gives every kind the catalogue uses a render arm on the Settings page', () => {
    const page = readFileSync(join(import.meta.dir, '..', '..', 'packages', 'myco-server', 'ui', 'src', 'features', 'admin', 'settings', 'LeafControl.tsx'), 'utf8');
    const used = [...new Set(LEAF_FIELDS.map((f) => f.kind))].sort();
    const unrendered = used.filter((kind) => !new RegExp(`field\\.kind === '${kind}'`).test(page));
    expect(unrendered).toEqual([]);
  });

  /**
   * Every setting the page shows says what the server does while nothing is
   * stored: the value it applies ("Server default: on", "14 days"), or what
   * leaving it unset means ("No limit"). A switch always has a value, since a
   * switch drawn off while the server treats it as on misstates the setting.
   */
  it('gives every setting still in use a server default or the words for unset', () => {
    const missing = LIVE_FIELDS.filter((f) => LEAF_DEFAULTS[f.leaf] === undefined).map((f) => f.leaf);
    expect(missing).toEqual([]);
    const toggles = LIVE_FIELDS.filter((f) => f.kind === 'toggle').filter((f) => {
      const entry = LEAF_DEFAULTS[f.leaf];
      return entry === undefined || !('value' in entry) || typeof entry.value !== 'boolean';
    }).map((f) => f.leaf);
    expect(toggles).toEqual([]);
    // A default for a setting the page no longer offers would be a second copy with no reader.
    expect(Object.keys(LEAF_DEFAULTS).filter((leaf) => !LIVE_FIELDS.some((f) => f.leaf === leaf)).sort()).toEqual([]);
  });

  /**
   * The catalogue retires exactly the leaves the server marks retired (`RETIRED_LEAVES`), which
   * `retired-settings.test.ts` holds to the leaves nothing reads, so the dashboard and the server
   * never disagree about a setting.
   */
  it('retires exactly the settings the server marks retired', () => {
    // Myco's own built-in exclusions are shown from the shared constant the map itself uses, not from the leaf.
    const shownFromShared = new Set(['cortex.canopy.exclude.default_patterns']);
    const wrong = LEAF_FIELDS.filter((f) => !shownFromShared.has(f.leaf) && (f.retired === true) !== RETIRED_LEAVES.has(f.leaf))
      .map((f) => `${f.leaf}: ${f.retired === true ? 'retired here, live on the server' : 'offered here, retired on the server'}`);
    expect(wrong).toEqual([]);
  });
});

/**
 * Retired editable contracts have no direct consumer outside their settings metadata owner.
 * The owner preserves archived provider preferences for the retained container probe;
 * its reader refuses every ordinary worker outcome. Derived views and stored-history
 * inspection do not admit writes. A new direct consumer changes this set and fails.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES, RETIRED_SECRET_SLOTS, executionProfileLeafDefault, runtimeProbePreferences } from '@myco-server-worker/core/settings.js';
import { OUTCOME_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { SECRET_SLOT_NAMES, harnessesReading } from '@goondocks/myco-shared/secret-slots';

const ROOT = fileURLToPath(new URL('../../packages/', import.meta.url));
const SERVER = join(ROOT, 'myco-server', 'src');
/** The code the member runs: its own modules, the hooks and capture it installs, and the worker. */
const MEMBER = ['myco/src/member', 'myco/src/hooks', 'myco/src/capture', 'myco/src/symbionts', 'myco/src/plans', 'myco-shared/src'].map((dir) => join(ROOT, dir));
/** Where the markers and the catalogue themselves are written: naming a leaf there is not reading it. */
const OWNERS = [join(SERVER, 'core', 'settings.ts'), join(ROOT, 'myco-shared', 'src', 'secret-slots.ts')];

const sources = (dir: string): string[] => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.generated\.ts$/.test(entry) && !OWNERS.includes(path) ? [path] : [];
  });
};

const SERVER_TEXT = sources(SERVER).map((file) => readFileSync(file, 'utf8'));
const MEMBER_TEXT = MEMBER.flatMap(sources).map((file) => readFileSync(file, 'utf8'));
const named = (texts: readonly string[], needle: string): boolean => texts.some((text) => text.includes(needle));
const namedLeaf = (texts: readonly string[], leaf: string): boolean => texts.some((text) =>
  [`'${leaf}'`, `"${leaf}"`, `\`${leaf}\``].some((literal) => text.includes(literal)));

describe('retired settings', () => {
  it('marks retired exactly the leaves with no direct reader outside the metadata owner', () => {
    expect(SERVER_TEXT.length).toBeGreaterThan(100);
    expect(MEMBER_TEXT.length).toBeGreaterThan(50);
    const unread = DEPLOYMENT_LEAVES.filter((leaf) => executionProfileLeafDefault(leaf, 'deployment') === null
      && !namedLeaf(SERVER_TEXT, leaf) && !namedLeaf(MEMBER_TEXT, leaf)).sort();
    expect([...RETIRED_LEAVES].sort()).toEqual(unread);
    // A leaf the Deployment does not hold is never marked.
    for (const leaf of RETIRED_LEAVES) expect({ leaf, held: DEPLOYMENT_LEAVES.includes(leaf) }).toEqual({ leaf, held: true });
  });

  it('refuses archived provider preferences for every ordinary worker outcome', async () => {
    const { db } = sqliteEnv();
    for (const task of OUTCOME_TASKS) {
      await expect(runtimeProbePreferences(db, task)).rejects.toThrow('only for the retained container probe');
    }
    expect(await runtimeProbePreferences(db, 'container-smoke')).toEqual({ type: null, model: null, baseUrl: null });
  });

  it('marks retired exactly the secret slots no server code and no harness run reads', () => {
    const unread = SECRET_SLOT_NAMES.filter((slot) => !named(SERVER_TEXT, `'${slot}'`) && harnessesReading(slot).length === 0).sort();
    expect([...RETIRED_SECRET_SLOTS].sort()).toEqual(unread);
  });
});

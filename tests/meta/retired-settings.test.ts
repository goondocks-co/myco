/** The active contract names no leaf without a consumer. */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES, RETIRED_SECRET_SLOTS, executionProfileLeafDefault } from '@myco-server-worker/core/settings.js';
import { V68_RETIRED_SETTINGS } from '@myco-server-worker/db/schema-v68.js';
import { runtimeProbeModel } from '@myco-server-worker/core/runtime-probe.js';
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

describe('settings retirement', () => {
  it('keeps the retired leaves out of the active contract and admits no unread leaf', () => {
    expect(SERVER_TEXT.length).toBeGreaterThan(100);
    expect(MEMBER_TEXT.length).toBeGreaterThan(50);
    const unread = DEPLOYMENT_LEAVES.filter((leaf) => executionProfileLeafDefault(leaf, 'deployment') === null
      && !namedLeaf(SERVER_TEXT, leaf) && !namedLeaf(MEMBER_TEXT, leaf)).sort();
    expect(unread).toEqual([]);
    expect([...RETIRED_LEAVES]).toEqual([]);
    for (const leaf of V68_RETIRED_SETTINGS) expect(DEPLOYMENT_LEAVES).not.toContain(leaf);
  });

  it('limits the runtime model to the container probe', async () => {
    const { db } = sqliteEnv();
    const probeEnv = { db, harnessCredentialSource: 'deployment' as const };
    for (const task of OUTCOME_TASKS) {
      await expect(runtimeProbeModel(probeEnv, task)).rejects.toThrow('only for the retained container probe');
    }
    expect(await runtimeProbeModel(probeEnv, 'container-smoke')).toBe('sonnet');
  });

  it('marks retired exactly the secret slots no server code and no harness run reads', () => {
    const unread = SECRET_SLOT_NAMES.filter((slot) => !named(SERVER_TEXT, `'${slot}'`) && harnessesReading(slot).length === 0).sort();
    expect([...RETIRED_SECRET_SLOTS].sort()).toEqual(unread);
  });
});

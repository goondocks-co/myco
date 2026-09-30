/**
 * Meta gate: the settings the Deployment marks retired are exactly the ones nothing reads.
 *
 * `RETIRED_LEAVES` and `RETIRED_SECRET_SLOTS` (`core/settings.ts`) are the one server-side source the dashboard marks
 * a setting retired from. A leaf is read when the server names it, or the 2.0 member it is served to does (the
 * member's own code, its hooks and capture, and the worker). A secret slot is read when the server names it or a
 * harness run is handed it (`HARNESS_CREDENTIALS`). A retired leaf that gains a reader, and a live one that loses its
 * last, both fail here, so the mark cannot drift from the code. Static source scan.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES, RETIRED_SECRET_SLOTS } from '@myco-server-worker/core/settings.js';
import { SECRET_SLOT_NAMES, harnessesReading } from '@goondocks/myco-shared/secret-slots';

const ROOT = fileURLToPath(new URL('../../packages/', import.meta.url));
const SERVER = join(ROOT, 'myco-server', 'src');
/** The code the member runs: its own modules, the hooks and capture it installs, and the worker. */
const MEMBER = ['myco/src/member', 'myco/src/hooks', 'myco/src/capture', 'myco/src/symbionts', 'myco/src/plans', 'myco-shared/src', 'myco-team/worker/src'].map((dir) => join(ROOT, dir));
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

describe('retired settings', () => {
  it('marks retired exactly the leaves neither the server nor the member reads', () => {
    expect(SERVER_TEXT.length).toBeGreaterThan(100);
    expect(MEMBER_TEXT.length).toBeGreaterThan(50);
    const unread = DEPLOYMENT_LEAVES.filter((leaf) => !named(SERVER_TEXT, leaf) && !named(MEMBER_TEXT, leaf)).sort();
    expect([...RETIRED_LEAVES].sort()).toEqual(unread);
    // A leaf the Deployment does not hold is never marked.
    for (const leaf of RETIRED_LEAVES) expect({ leaf, held: DEPLOYMENT_LEAVES.includes(leaf) }).toEqual({ leaf, held: true });
  });

  it('marks retired exactly the secret slots no server code and no harness run reads', () => {
    const unread = SECRET_SLOT_NAMES.filter((slot) => !named(SERVER_TEXT, `'${slot}'`) && harnessesReading(slot).length === 0).sort();
    expect([...RETIRED_SECRET_SLOTS].sort()).toEqual(unread);
  });
});

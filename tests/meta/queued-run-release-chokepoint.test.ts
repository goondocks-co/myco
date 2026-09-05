/**
 * Meta gate: a queued run ends in one place.
 *
 * A queued row can carry the credential of a launch that may have started a
 * child, and ending the row is the last moment anything can retire it — the
 * retention pass then deletes the row, and nothing names the credential again.
 * `endQueuedRun` is what pairs the transition with the release. A second caller
 * writing a queued row terminal on its own is how a live credential outlives
 * every reader of it, which is exactly the shape that made this gate necessary.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));

/** Where each may be named: its own definition, and the chokepoint that pairs it with the release. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'failQueuedRun': ['core/runs.ts', 'core/harness.ts'],
  'skipQueued': ['core/runs.ts', 'core/harness.ts'],
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('meta: ending a queued run', () => {
  it('happens only through the release that retires what the row holds', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(SRC.length);
      for (const [name, allowed] of Object.entries(ALLOWED)) {
        if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
        if (!allowed.includes(relative)) offenders.push(`${relative}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names the chokepoint in the one file allowed to call the transitions', () => {
    const harness = readFileSync(join(SRC, 'core', 'harness.ts'), 'utf8');
    // Both transitions live inside the release; nothing else in this file reaches them.
    const release = harness.slice(harness.indexOf('export async function endQueuedRun'));
    const body = release.slice(0, release.indexOf('\n}\n') + 3);
    for (const name of Object.keys(ALLOWED)) {
      expect({ name, inside: new RegExp(`\\b${name}\\s*\\(`).test(body) }).toEqual({ name, inside: true });
      // One occurrence in the file, and it is that one.
      expect({ name, calls: harness.match(new RegExp(`\\b${name}\\s*\\(`, 'g'))?.length ?? 0 }).toEqual({ name, calls: 1 });
    }
    expect(release).toContain('revokeCredentialOfMember');
  });
});

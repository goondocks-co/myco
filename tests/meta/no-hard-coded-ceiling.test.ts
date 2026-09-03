/**
 * A constraint on how much intelligence runs is a Settings leaf, never a
 * number in the code: a limit means a queue, and a queue is configured by the
 * person who pays for the runs. This holds the server source free of any
 * per-hour, per-something or concurrency ceiling constant.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('dispatch constraints', () => {
  it('names no ceiling in the server source: every limit is a Settings leaf', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8');
      // A bound on one request's size is a different thing from a ceiling on runs; only the latter is named here.
      for (const match of source.matchAll(/\b(MAX_[A-Z_]*_PER_(?:HOUR|DAY|MINUTE|PROJECT)[A-Z_]*|[A-Z_]+_PER_(?:HOUR|DAY)|MAX_CONCURRENT[A-Z_]*)\b/g)) {
        offenders.push(`${file.slice(SRC.length)}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

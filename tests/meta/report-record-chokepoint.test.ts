/**
 * Every report a run files lands through `recordReport`, which refuses an
 * action the run's task cannot close under. The raw insert is reachable from
 * that one function alone: a door added later that reached it directly would
 * record a row the judgment then ignores, which is the defect the chokepoint
 * closes.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));
const ALLOWED: readonly string[] = ['core/runs.ts', 'core/run-postconditions.ts'];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('meta: recording a run report', () => {
  it('reaches the raw insert only through the chokepoint that refuses an action the task cannot close under', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const relative = file.slice(SRC.length);
      if (/\binsertReport\s*\(/.test(readFileSync(file, 'utf8')) && !ALLOWED.includes(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('is what both report doors call', () => {
    for (const door of ['mcp/tools/run.ts', 'api/runs.ts']) {
      expect({ door, records: /\brecordReport\s*\(/.test(readFileSync(join(SRC, door), 'utf8')) }).toEqual({ door, records: true });
    }
  });
});

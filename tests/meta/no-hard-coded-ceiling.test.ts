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

/**
 * The one bound in this shape that is NOT the owner's to set.
 *
 * A run the platform replaced is re-queued by the Deployment itself, with
 * nobody asking. That recovery has to stop, and stop at a number no setting can
 * raise: a Deployment rolling again and again would otherwise turn one dispatch
 * into a stream of them, and the leaf that lifted the cap would be the leaf
 * that opened the loop. What an owner does control is how much runs at all —
 * `agent.limits.*` holds every successor like any other dispatch.
 */
const NOT_THE_OWNER_S: ReadonlySet<string> = new Set(['core/harness.ts: REPLACED_REQUEUES_PER_DAY']);

describe('dispatch constraints', () => {
  it('names no ceiling in the server source: every limit is a Settings leaf', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8');
      // A bound on one request's size is a different thing from a ceiling on runs; only the latter is named here.
      for (const match of source.matchAll(/\b(MAX_[A-Z_]*_PER_(?:HOUR|DAY|MINUTE|PROJECT)[A-Z_]*|[A-Z_]+_PER_(?:HOUR|DAY)|MAX_CONCURRENT[A-Z_]*)\b/g)) {
        const named = `${file.slice(SRC.length)}: ${match[1]}`;
        if (!NOT_THE_OWNER_S.has(named)) offenders.push(named);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the exemption to what actually stands in the source', () => {
    const named = new Set<string>();
    for (const file of files(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\b([A-Z_]+_PER_(?:HOUR|DAY))\b/g)) named.add(`${file.slice(SRC.length)}: ${match[1]}`);
    }
    for (const exempt of NOT_THE_OWNER_S) expect({ exempt, present: named.has(exempt) }).toEqual({ exempt, present: true });
  });
});

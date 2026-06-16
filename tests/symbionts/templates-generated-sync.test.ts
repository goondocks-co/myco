import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Codegen-sync guard. `src/symbionts/templates.generated.ts` is auto-generated
 * from `src/symbionts/templates/` and is the ONLY thing the Bun-compiled binary
 * reads — it can't fs.readFileSync the templates inside the /$bunfs/ virtual
 * filesystem. A forgotten `npm run codegen` therefore silently ships stale
 * templates.
 *
 * `gen-templates.mjs --check` regenerates the bundle in memory and compares it
 * to the committed file, exiting non-zero (with a clear message) on drift. This
 * test runs that check, so any future template edit committed without a
 * regenerated bundle fails the suite here instead of in production.
 */

const SCRIPT = path.resolve('packages/myco/scripts/gen-templates.mjs');

describe('templates.generated.ts codegen sync', () => {
  it('is up to date with src/symbionts/templates/ (gen-templates --check exits 0)', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    // Surface the script's own stale-bundle message when the check fails, so
    // the fix (`npm run codegen`) is obvious from the test output.
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  });
});

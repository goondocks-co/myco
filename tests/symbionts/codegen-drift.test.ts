/**
 * Codegen drift guard.
 *
 * The bun binary embeds ONLY the generated bundles (`skills.generated.ts`,
 * `templates.generated.ts`) — a hand edit to a source skill/template without
 * re-running `npm run codegen` silently ships stale embedded content. These
 * tests invoke each generator's `--check` mode (byte-compares the committed
 * bundle against a fresh generation) so drift fails CI, not production.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function runCheck(script: string): { status: number | null; output: string } {
  const res = spawnSync('node', [path.join('packages/myco/scripts', script), '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

describe('codegen drift guard', () => {
  it('skills.generated.ts is in sync with the skills tree (run `npm run codegen`)', () => {
    const { status, output } = runCheck('gen-skills.mjs');
    if (status !== 0) throw new Error(`gen-skills --check failed:\n${output}`);
    expect(status).toBe(0);
  });

  it('templates.generated.ts is in sync (run `npm run codegen`)', () => {
    const { status, output } = runCheck('gen-templates.mjs');
    if (status !== 0) throw new Error(`gen-templates --check failed:\n${output}`);
    expect(status).toBe(0);
  });
});

/**
 * Codegen drift guard.
 *
 * The compiled binary and the distributable plugin bundle both read generated
 * files — a hand edit to a source skill or template without re-running codegen
 * silently ships stale content. Each generator that supports `--check`
 * byte-compares its committed output against a fresh generation, so drift fails
 * CI rather than production.
 *
 * The generator list is DERIVED from the `codegen` script in
 * `packages/myco/package.json`, including the runner each one is invoked with.
 * A hand-written list here would be a second copy of that script: a generator
 * added to the chain and forgotten here would go unchecked, and nothing would
 * say so. Checkability is read from each generator's own source, so a generator
 * without `--check` is skipped rather than being run in write mode by a test.
 */
import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'packages/myco/scripts');

interface Generator {
  readonly runner: string;
  readonly script: string;
  readonly checkable: boolean;
}

/** Every `<runner> scripts/<file>` the codegen chain invokes, in order. */
function generators(): Generator[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/myco/package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const chain = pkg.scripts.codegen;
  return [...chain.matchAll(/(\S+)\s+(scripts\/\S+)/g)].map(([, runner, script]) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'packages/myco', script), 'utf-8');
    return { runner, script, checkable: source.includes('--check') };
  });
}

function runCheck(gen: Generator): { status: number | null; output: string } {
  const args = gen.runner === 'node' ? [gen.script, '--check'] : ['--import', 'tsx', gen.script, '--check'];
  const res = spawnSync('node', args, { cwd: path.join(REPO_ROOT, 'packages/myco'), encoding: 'utf-8' });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

describe('codegen drift guard', () => {
  const all = generators();
  const checkable = all.filter((g) => g.checkable);

  it('reads the generator chain from the codegen script', () => {
    // A parse that matched nothing would make every case below vacuous, so the
    // shape of what was derived is asserted before it is used.
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((g) => fs.existsSync(path.join(SCRIPTS_DIR, path.basename(g.script))))).toBe(true);
    expect(checkable.length).toBeGreaterThan(0);
  });

  for (const gen of checkable) {
    it(`${gen.script} output is in sync (run \`npm run codegen\`)`, () => {
      const { status, output } = runCheck(gen);
      if (status !== 0) throw new Error(`${gen.script} --check failed:\n${output}`);
      expect(status).toBe(0);
    });
  }
});

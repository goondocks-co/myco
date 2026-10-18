import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const source = path.resolve('Makefile');
it('finishes checks before building even under make -j', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-make-order-'));
  try {
    fs.writeFileSync(path.join(root, 'Makefile'), `include ${source}\ndeps:\n\t@node -e ""\ncheck-fast:\n\t@node -e "setTimeout(()=>require('fs').writeFileSync('checked','yes'),100)"\nbuild-only:\n\t@test -f checked\n`);
    const result = spawnSync('make', ['-j2', '-o', 'lint', '-o', 'test-fast', 'build'], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr.replace(/^.*warning:.*\n/gm, '') }).toEqual({ status: 0, stderr: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const retiredDogfood = /\bdev-(?:wrapper|install|link(?:-worktree)?|deploy|unlink(?:-worktree)?|build(?:-windows)?)\b|\bmyco-dev\b/;
const guidanceRoots = ['Makefile', 'AGENTS.md', 'CONTRIBUTING.md', 'docs', '.agents/skills', 'packages/myco/skills', 'plugins/myco/README.md'];
const excludedGuidance = [':(exclude)CHANGELOG.md', ':(exclude)**/fixtures/**', ':(exclude)scripts/win-*.ps1'];

function retiredGuidanceReferences(root: string): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...guidanceRoots, ...excludedGuidance], { cwd: root, encoding: 'utf8' });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(listed.stderr);
  return listed.stdout.split('\0').filter(Boolean).flatMap(file => fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .flatMap((line, index) => retiredDogfood.test(line) ? [`${file}:${index + 1}: ${line}`] : []));
}

it('keeps retired dogfood targets and wrapper wording out of tracked published guidance', () => {
  expect(retiredGuidanceReferences(process.cwd())).toEqual([]);
});

it('ignores untracked plans while checking tracked guidance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-guidance-tracked-'));
  try {
    const env = sandboxChildEnv(root);
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    };
    git(['init', '-q']);
    fs.mkdirSync(path.join(root, 'docs/superpowers'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'docs/superpowers/\n');
    fs.writeFileSync(path.join(root, 'docs/superpowers/plan.md'), 'Run make dev-link.\n');
    fs.writeFileSync(path.join(root, 'docs/configuration.md'), 'Run make source-install.\n');
    git(['add', 'docs/configuration.md']);
    expect(retiredGuidanceReferences(root)).toEqual([]);
    fs.writeFileSync(path.join(root, 'docs/configuration.md'), 'Run make dev-link.\n');
    expect(retiredGuidanceReferences(root)).toEqual(['docs/configuration.md:1: Run make dev-link.']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

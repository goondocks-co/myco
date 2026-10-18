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

const retiredTargets = /\bdev-(?:wrapper|install|link(?:-worktree)?|deploy|unlink(?:-worktree)?|build(?:-windows)?)\b/;
const guidanceRoots = ['AGENTS.md', 'CONTRIBUTING.md', 'docs', '.agents/skills', 'packages/myco/skills'];

function guidanceFiles(entry: string): string[] {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) return [];
  return stat.isDirectory()
    ? fs.readdirSync(entry).flatMap(name => guidanceFiles(path.join(entry, name)))
    : [entry];
}

it('keeps retired dogfood targets out of the Makefile and published guidance', () => {
  const files = [source, ...guidanceRoots.flatMap(guidanceFiles)];
  const matches = files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
    .flatMap((line, index) => retiredTargets.test(line) ? [`${path.relative(process.cwd(), file)}:${index + 1}: ${line}`] : []));
  expect(matches).toEqual([]);
});

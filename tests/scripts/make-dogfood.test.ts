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
    fs.writeFileSync(path.join(root, 'Makefile'), `include ${source}\ncheck-fast:\n\t@node -e "setTimeout(()=>require('fs').writeFileSync('checked','yes'),100)"\nbuild-only:\n\t@test -f checked\n`);
    const result = spawnSync('make', ['-j2', '-o', 'lint', '-o', 'test-fast', 'build'], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr.replace(/^.*warning:.*\n/gm, '') }).toEqual({ status: 0, stderr: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it.each([false, true])('keeps the dogfood binary safe through a wrapper symlink (failed probe: %s)', (fails) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dev-install-'));
  const home = path.join(root, 'home');
  const binary = path.join(home, '.myco-dev/bin/myco');
  const wrapper = path.join(home, '.local/bin/myco-dev');
  const built = path.join(root, 'packages/myco-fixture/bin/myco');
  const content = `#!/bin/sh\n${fails ? 'exit 1' : 'echo fixture-version'}\n`;
  try {
    for (const file of [binary, wrapper, built]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(source, path.join(root, 'Makefile'));
    fs.writeFileSync(binary, 'original binary');
    fs.symlinkSync(binary, wrapper);
    fs.writeFileSync(built, content, { mode: 0o755 });
    const result = spawnSync('make', ['dev-install', 'HOST_TARGET=fixture', `HOME=${home}`, `PWD=${root}`], { cwd: root, env: sandboxChildEnv(root, { HOME: home }), encoding: 'utf8' });
    expect(fs.readFileSync(binary, 'utf8')).toBe(fails ? 'original binary' : content);
    expect(fs.existsSync(binary + '.new')).toBe(false);
    if (fails) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('failed its --version probe');
    } else {
      expect(result.status).toBe(0);
      expect(fs.lstatSync(wrapper).isSymbolicLink()).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

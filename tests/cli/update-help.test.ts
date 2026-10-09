import { afterAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-help-'));
const cli = path.resolve('packages/myco/src/cli.ts');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function help(...args: string[]): string {
  const ran = spawnSync(process.execPath, [cli, ...args, '--help'], { cwd: root, env: sandboxChildEnv(root), encoding: 'utf8', timeout: 30_000 });
  expect({ status: ran.status, stderr: ran.stderr }).toEqual({ status: 0, stderr: '' });
  return ran.stdout;
}
it('lists the one update command with its channel and names its alias only in command help', () => {
  for (const legacy of [false, true]) {
    if (legacy) fs.mkdirSync(path.join(root, '.myco', 'groves'), { recursive: true });
    const list = help();
    expect(list).toMatch(/update\s+Update Myco within its recorded channel/);
    expect(list).not.toContain('Update vault files');
    expect(list).not.toContain('upgrade');
  }
  const update = help('update');
  expect(update).toBe(help('upgrade'));
  expect(update).toContain('Usage: myco update');
  for (const flag of ['--check', '--channel', '--target-version']) expect(update).toContain(flag);
  expect(update.match(/Alias: myco upgrade/g)).toHaveLength(1);
});
it('every listed top-level command has specific help before any vault or membership gate', () => {
  const commands = [...new Set([...help().matchAll(/^  ([a-z][a-z-]*)\s/gm)].map(match => match[1]!))];
  for (const command of commands) {
    const text = help(command);
    expect({ command, text }).not.toEqual({ command, text: expect.stringContaining('for the full command list') });
    expect(text.trim().length).toBeGreaterThan(`Usage: myco ${command} [args]`.length);
  }
});

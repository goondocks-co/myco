import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { legacyFixtureHome } from '../setup/fixtures/legacy-home.ts';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

for (const command of ['mcp', 'tool']) for (const kind of ['empty', 'member', 'legacy']) it(`credential-less ${command} refuses a ${kind} home without spawning any process`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-no-legacy-runtime-'));
  try {
    const env = sandboxChildEnv(root);
    delete env.MYCO_NO_AUTO_SPAWN;
    if (kind === 'member') {
      fs.mkdirSync(path.join(env.MYCO_HOME!, 'member'), { recursive: true });
      fs.writeFileSync(path.join(env.MYCO_HOME!, 'member', 'cutover.json'), '{}');
    }
    if (kind === 'legacy') env.MYCO_HOME = legacyFixtureHome(root).mycoHome;
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../fixtures/no-legacy-spawn.ts'), command], {
      cwd: root, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.stderr).not.toContain('FORBIDDEN_PROCESS_SPAWN');
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('--credential registry');
    expect(output).toContain('myco member provision');
    if (kind === 'empty') expect(fs.existsSync(path.join(env.MYCO_HOME!, 'groves'))).toBe(false);
    if (kind === 'legacy') expect(output).toContain('myco cutover --dry-run');
    expect(fs.existsSync(path.join(env.MYCO_HOME!, 'service', 'daemon.json'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

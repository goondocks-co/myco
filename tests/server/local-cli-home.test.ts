import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

it('native CLI and guided setup keep the same non-default home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-cli-home-'));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  try {
    const env = sandboxChildEnv(root, { MYCO_HOME: path.join(root, 'custom-myco') });
    const child = spawnSync(process.execPath, ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'),
      '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/native_cli_home_test.ts')],
    { env, cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

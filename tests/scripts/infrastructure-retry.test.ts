import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('an infrastructure fault does not hide a load error in the same phase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-retry-'));
  const connect = path.join(dir, 'connect.test.ts');
  const missing = path.join(dir, 'missing.test.ts');
  fs.writeFileSync(connect, "import { test } from 'bun:test';\ntest('connect', () => { throw new TypeError('Unable to connect'); });\n");
  fs.writeFileSync(missing, "import { missing } from './no-such-module';\nimport { test } from 'bun:test';\ntest('missing', () => { missing(); });\n");
  try {
    const run = spawnSync(process.execPath, ['scripts/run-bun-tests.mjs', connect, missing], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    expect(run.status).not.toBe(0);
    expect(output).toContain('Unhandled error between tests');
    expect(output).not.toContain('passed after infrastructure retry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STDIN_FIXTURE = 'tests/fixtures/runner/stdin_read_test.ts';

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['scripts/run-bun-tests.mjs', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('an infrastructure fault clears beside a passing file and stays failed beside a load error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-retry-'));
  const marker = path.join(dir, 'flip');
  const connect = path.join(dir, 'connect.test.ts');
  fs.writeFileSync(connect, `import { test } from 'bun:test';
import fs from 'node:fs';
test('connect', () => {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, '1');
    throw new TypeError('Unable to connect');
  }
});
`);
  fs.writeFileSync(path.join(dir, 'ok.test.ts'), "import { test } from 'bun:test';\ntest('ok', () => {});\n");
  fs.writeFileSync(path.join(dir, 'missing.test.ts'), "import { missing } from './no-such-module';\nimport { test } from 'bun:test';\ntest('missing', () => { missing(); });\n");
  try {
    const cleared = run([connect, path.join(dir, 'ok.test.ts')]);
    expect(cleared.status).toBe(0);
    expect(cleared.output).toContain('Infrastructure retry:');
    expect(cleared.output).toContain('passed after infrastructure retry');
    fs.rmSync(marker, { force: true });
    const hidden = run([connect, path.join(dir, 'missing.test.ts')]);
    expect(hidden.status).not.toBe(0);
    expect(hidden.output).toContain('Unhandled error between tests');
    expect(hidden.output).not.toContain('Infrastructure retry:');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

test('a JUnit failure and a run with zero tests fail even when Bun exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const bun = path.join(bin, 'bun');
  fs.writeFileSync(bun, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const file = args.find((arg) => arg.startsWith('--reporter-outfile=')).slice('--reporter-outfile='.length);
const xml = process.env.FAKE_BUN_MODE === 'zero'
  ? '<testsuites><testsuite tests="0" failures="0" errors="0" /></testsuites>'
  : '<testsuites><testsuite tests="1" failures="1" errors="0"><testcase name="fixture"><failure type="AssertionError" /></testcase></testsuite></testsuites>';
fs.writeFileSync(file, xml);
console.error(' 1 pass\\n 0 fail');
`);
  fs.chmodSync(bun, 0o755);
  try {
    const failed = run([STDIN_FIXTURE], { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_BUN_MODE: 'junit-fail' });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('JUnit aggregated 1 failure');
    const empty = run([STDIN_FIXTURE], { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_BUN_MODE: 'zero' });
    expect(empty.status).not.toBe(0);
    expect(empty.output).toContain('zero executed tests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

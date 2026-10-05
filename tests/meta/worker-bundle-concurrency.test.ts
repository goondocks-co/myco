import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../helpers/import-closure.ts';

test.skipIf(process.platform === 'win32')('concurrent bundle prerequisites keep their configurations through sibling cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worker-concurrency-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'npx');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const config = args[args.indexOf('-c') + 1];
const out = args[args.indexOf('--outdir') + 1];
const root = process.env.BUNDLE_PROBE_ROOT;
const role = process.env.BUNDLE_PROBE_ROLE;
fs.writeFileSync(path.join(root, role + '-ready'), config);
if (role === 'atomic') { fs.writeFileSync(path.join(out, 'index.js'), 'export const bundleProbe = true;'); process.exit(0); }
(async () => {
  const deadline = Date.now() + 15000;
  const barrier = path.join(root, role === 'first' ? 'second-ready' : 'release-second');
  while (!fs.existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error('bundle barrier timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const text = fs.readFileSync(config, 'utf8');
  if (!text.includes('main = "src/index.ts"')) throw new Error('wrong bundle config');
  fs.writeFileSync(path.join(out, 'index.js'), 'export const bundleProbe = true;');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`);
  fs.chmodSync(executable, 0o755);
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, 'packages/myco/scripts/gen-worker-bundle.ts')).href;
  const run = (role: string) => new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const script = role === 'atomic' ? `
      import fs from 'node:fs';
      const output = process.argv[1];
      fs.writeFileSync(output, 'previous complete module');
      const write = fs.writeFileSync;
      fs.writeFileSync = (file, ...args) => {
        if (String(file).startsWith(output)) { write(file, 'partial module'); throw new Error('injected output failure'); }
        return write(file, ...args);
      };
      const { emitWorkerBundle } = await import(${JSON.stringify(moduleUrl)});
      try { emitWorkerBundle(output, 'fixture'); throw new Error('write did not fail'); }
      catch (error) { if (error.message !== 'injected output failure') throw error; }
      if (fs.readFileSync(output, 'utf8') !== 'previous complete module') throw new Error('published a partial module');
    ` : `import { emitWorkerBundle } from ${JSON.stringify(moduleUrl)}; emitWorkerBundle(process.argv[1], 'fixture');`;
    const child = spawn('node', ['--import', 'tsx', '--input-type=module', '-e',
      script,
      path.join(root, `${role}.generated.ts`)], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BUNDLE_PROBE_ROOT: root, BUNDLE_PROBE_ROLE: role },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, output }));
  });
  try {
    const first = run('first');
    const second = run('second');
    const completedFirst = await first;
    fs.writeFileSync(path.join(root, 'release-second'), 'ready');
    const completedSecond = await second;
    expect(completedFirst).toEqual({ status: 0, output: '' });
    expect(completedSecond).toEqual({ status: 0, output: '' });
    expect(await run('atomic')).toEqual({ status: 0, output: '' });
    expect(fs.readdirSync(root).some((file) => file.endsWith('.tmp'))).toBe(false);
    const configs = ['first', 'second'].map((role) => fs.readFileSync(path.join(root, `${role}-ready`), 'utf8'));
    expect(configs[0]).not.toBe(configs[1]);
    for (const config of configs) expect(fs.existsSync(config)).toBe(false);
    for (const role of ['first', 'second']) expect(fs.readFileSync(path.join(root, `${role}.generated.ts`), 'utf8')).toContain('BUNDLED_WORKER');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

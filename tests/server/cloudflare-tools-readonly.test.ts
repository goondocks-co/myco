import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeReport } from '@myco/cli/member-doctor.js';
import { saveSetupFile } from '@myco/setup/answers.js';
import { observeSetupStatus } from '@myco/setup/observe.js';
import { BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';

it.skipIf(process.platform === 'win32')('doctor and setup status discover operator tools without network or filesystem writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tools-readonly-'));
  const home = path.join(root, 'myco');
  const bin = path.join(root, 'bin');
  const prefix = path.join(root, 'operator');
  fs.mkdirSync(bin);
  fs.symlinkSync(Bun.which('node')!, path.join(bin, 'node'));
  fs.symlinkSync(Bun.which('npm')!, path.join(bin, 'npm'));
  const env = { HOME: path.join(root, 'person'), MYCO_HOME: home, PATH: bin, TMPDIR: path.join(root, 'tmp'),
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'appdata'),
    npm_config_prefix: prefix, npm_config_userconfig: path.join(root, 'npmrc'), npm_config_globalconfig: path.join(root, 'global-npmrc'), npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  saveSetupFile(home, { version: 1, answers: { role: 'create', target: 'cloudflare' }, consented: {} });
  const snapshot = () => fs.readdirSync(root, { recursive: true }).sort();
  const check = async () => {
    const before = snapshot();
    const doctor = await homeReport(home);
    const status = await observeSetupStatus(home, { role: 'create', target: 'cloudflare' }, { agents: () => [], legacyHomeDir: env.HOME, legacyHomes: [] }, true);
    expect(snapshot()).toEqual(before);
    return { doctor: doctor.find(row => row.name === 'Wrangler'), status: status.find(row => row.id === 'cloudflare.tools') };
  };
  try {
    expect((await check()).doctor?.status).toBe('warn');
    const installed = path.join(prefix, 'lib', 'node_modules', 'wrangler');
    fs.mkdirSync(path.join(installed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'wrangler', bin: { wrangler: 'bin/wrangler.js' } }));
    fs.writeFileSync(path.join(installed, 'bin', 'wrangler.js'), `require('node:module').enableCompileCache?.(); console.log(${JSON.stringify(BUNDLED_WORKER_WRANGLER)});`);
    const local = path.join(home, 'node_modules', 'wrangler');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'package.json'), 'malformed');
    expect((await check()).doctor?.status).toBe('ok');
    const outside = path.join(root, 'outside.cjs');
    fs.writeFileSync(outside, `console.log(${JSON.stringify(BUNDLED_WORKER_WRANGLER)});`);
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: 'wrangler', bin: path.relative(local, outside) }));
    const observed = await check();
    expect(observed.doctor?.status).toBe('ok');
    expect(observed.status?.state).toBe('complete');
    expect(observed.doctor?.detail).toContain(installed);
    expect(observed.doctor?.detail).toContain('node ');
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

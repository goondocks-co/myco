import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalPaths, writeLocalRecord } from '@myco/server/local.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

it('routes backup and restore flags to the selected retained target without invoking Compose', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-cli-'));
  const paths = resolveLocalPaths(path.join(root, 'home'));
  const fixture = sqliteEnv();
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  writeLocalRecord({ port: 8787, sourceFrom: 'socket' }, paths);
  fixture.sqlite.query('VACUUM INTO ?').run(paths.databasePath);
  const original = fs.readFileSync(paths.databasePath);
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.join(repo, 'tsconfig.json'), '-e',
      `import {run} from ${JSON.stringify(path.join(repo, 'packages/myco/src/cli/server.ts'))}; await run(${JSON.stringify(args)});`], {
      cwd: root, env: { ...process.env, MYCO_HOME: path.join(root, 'home'), MYCO_TRAMPOLINED: '1', PATH: root },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => { child.kill(); }, 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, text: stdout + stderr };
    } finally { clearTimeout(timeout); child.kill(); }
  };
  try {
    const destination = path.join(root, 'backup');
    const local = await invoke(['backup', '--target', 'local', '--to', destination]);
    expect(local.code).toBe(0);
    expect(local.text).toContain('Verified data artifact');
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8')).status).toBe('complete');
    const cloud = await invoke(['backup', '--target', 'cloudflare', '--account-id', 'fixture-account', '--to', path.join(root, 'cloud')]);
    expect(cloud.code).toBe(1);
    expect(cloud.text).toContain('No Cloudflare Deployment record');
    const restore = await invoke(['restore', '--target', 'local', '--from', destination, '--yes']);
    expect(restore.code).toBe(1);
    expect(restore.text).toContain('native recovery needs --secrets-from');
    const existing = await invoke(['restore', '--target', 'local', '--from', destination, '--secrets-from', paths.secretsFile, '--yes']);
    expect(existing.code).toBe(1);
    expect(existing.text).toContain('fresh local Deployment directory');
    const bare = await invoke(['backup', '--target', 'local', '--to']);
    expect(bare.code).toBe(1);
    expect(bare.text).toContain('backup needs --to <dir>');
    expect(fs.existsSync(path.join(root, 'true'))).toBe(false);
    expect(fs.readFileSync(paths.databasePath)).toEqual(original);
  } finally { fixture.sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

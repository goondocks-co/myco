import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { writeInstallMarker } from '@myco/install/managed-binary.js';
import { readRunnerUpdateState } from '@myco/runner/update.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-update-compiled-'));
const versions = ['2.0.0-alpha.2', '2.0.0-alpha.3'] as const;
const files = versions.map(version => path.join(root, `myco-${version}`));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(() => {
  for (const [i, version] of versions.entries()) {
    const result = spawnSync(process.execPath, ['build', '--compile', './tests/fixtures/runner/update-cli.ts', '--define', `MYCO_UPDATE_FIXTURE_VERSION=${JSON.stringify(version)}`, '--outfile', files[i]!],
      { env: sandboxChildEnv(root), cwd: process.cwd(), encoding: 'utf8', timeout: 120000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    if (process.platform === 'darwin') expect(spawnSync('codesign', ['--force', '--sign', '-', files[i]!], { env: sandboxChildEnv(root), cwd: root, encoding: 'utf8' }).status).toBe(0);
  }
}, 250000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'darwin')('compiled runner update workflow', () => {
  for (const trigger of ['cli', 'dashboard'] as const) {
    it(`registers, applies the local fixture release from ${trigger}, restarts via stub and reports outcome`, async () => {
      const cwd = path.join(root, trigger); fs.mkdirSync(cwd);
      const binary = path.join(cwd, 'service-bin', 'myco'); fs.mkdirSync(path.dirname(binary)); fs.copyFileSync(files[0]!, binary);
      const asset = `myco-darwin-${process.arch}`;
      const sum = crypto.createHash('sha256').update(fs.readFileSync(files[1]!)).digest('hex');
      let report: Record<string, unknown> | undefined;
      let requested = trigger === 'dashboard';
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/releases') {
          expect(request.headers.get('authorization')).toBeNull();
          return Response.json([{ tag_name: `myco/v${versions[1]}`, prerelease: true, assets: [
          { name: asset, browser_download_url: `${server.url.origin}/binary` }, { name: 'SHA256SUMS', browser_download_url: `${server.url.origin}/sums` },
        ] }], { headers: { etag: 'fixture' } });
        }
        if (url.pathname === '/binary') return new Response(Bun.file(files[1]!));
        if (url.pathname === '/sums') return new Response(`${sum}  ${asset}\n`);
        if (url.pathname === '/auth/runner/start') return Response.json({ device_code: 'd'.repeat(43), user_code: 'BCDF-2345', expires_in: 600, interval: 1 });
        if (url.pathname === '/auth/runner/poll') return Response.json({ registered: true, runnerId: 'runner_fixture', deploymentId: 'dep_fixture', name: 'mini' });
        if (url.pathname === '/runners/contact') {
          const body = await request.json() as { update?: Record<string, unknown> };
          if (body.update?.lastResult) { report = body.update; requested = false; }
          return Response.json({ persisted: true, runner: { id: 'runner_fixture', deploymentId: 'dep_fixture', name: 'mini', state: 'enabled' },
            credential: { id: 'credential_fixture', expiresAt: Date.now() + 600000, refreshAfter: Date.now() + 500000 },
            updateRequest: requested ? { id: 'dashboard_fixture', requestedAt: Date.now() } : null,
          }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
        }
        if (url.pathname === '/worker/claim') return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
        return Response.json({ persisted: true });
      } });
      const serverUrl = server.url.origin;
      const env = sandboxChildEnv(cwd, { MYCO_UPDATE_FIXTURE_BINARY: binary, MYCO_UPDATE_FIXTURE_SERVER: serverUrl, GITHUB_TOKEN: '', GH_TOKEN: '' });
      const invoke = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(binary, ['runner', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
      });
      try {
        writeInstallMarker(env.MYCO_HOME!, { channel: 'alpha', source: 'curl', bin: path.join(cwd, 'wrong-destination') });
        expect(await invoke('register', serverUrl, '--name', 'mini')).toMatchObject({ code: 0 });
        expect(await invoke('install', '--server', serverUrl)).toMatchObject({ code: 0 });
        const checked = await invoke('update', '--check');
        expect(checked.code).toBe(0); expect(checked.stdout).toContain(versions[1]);
        const updating = await invoke(trigger === 'cli' ? 'update' : 'run', '--server', serverUrl);
        expect(updating.code).toBe(trigger === 'cli' ? 0 : 1);
        for (let tries = 0; tries < 200 && !report; tries++) await wait(50);
        expect(report).toMatchObject({ channel: 'alpha', currentVersion: versions[1], lastResult: { fromVersion: versions[0], toVersion: versions[1], result: 'updated', ...(trigger === 'dashboard' ? { requestId: 'dashboard_fixture' } : {}) } });
        expect(readRunnerUpdateState(env.MYCO_HOME!).transaction).toBeUndefined();
        const state = JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'fixture-service-state.json'), 'utf8')) as { commands: string[] };
        expect(state.commands.some(command => command.startsWith('launchctl load'))).toBe(true);
        const probe = spawnSync(binary, ['--version'], { cwd, env, encoding: 'utf8' });
        expect(probe.status).toBe(0); expect(probe.stdout.trim()).toBe(versions[1]);
      } finally {
        await server.stop(true);
        const pidFile = path.join(env.MYCO_HOME!, 'fixture-pids');
        if (fs.existsSync(pidFile)) for (const line of fs.readFileSync(pidFile, 'utf8').trim().split('\n')) {
          const pid = Number(line); if (!Number.isSafeInteger(pid) || pid < 1) continue;
          try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        for (let tries = 0; tries < 100; tries++) {
          const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : [];
          if (pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
          await wait(10);
        }
      }
    }, 30000);
  }
});

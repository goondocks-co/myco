import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLocalSignIn, ensureLocalSecrets, readLocalSecrets, resolveLocalPaths, writeLocalRecord } from '@myco/server/local.js';
import { materializeBundle, resolveDeploymentPaths } from '@myco/server/deployment.js';
import { LocalVolume, volumeIdentity, type VolumeStartup } from '@myco/server/local-volume.js';

/** A start that needs no volume mutation: the shape a serving process takes its lease with. */
const servingVolume = (paths: { databasePath: string }): VolumeStartup<{ stop(): Promise<void> }> => ({
  pending: () => false,
  startup: () => {},
  identity: () => volumeIdentity(paths.databasePath, () => null),
  start: async () => ({ stop: async () => {} }),
});
import { registerGitHubApp, resolveSignInTarget } from '@myco/server/github-app.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'myco-native-signin-'));
  const paths = resolveLocalPaths(home);
  writeLocalRecord({ port: 18806, sourceFrom: 'socket' }, paths);
  ensureLocalSecrets(paths);
  return { home, paths, url: 'http://127.0.0.1:18806' };
}

describe('native sign-in registration', () => {
  it('resolves a native record and refuses ambiguous automatic selection', async () => {
    const f = fixture();
    expect(resolveSignInTarget(undefined, f.home)).toEqual({ kind: 'local', paths: f.paths });
    expect(resolveSignInTarget('local', f.home)).toEqual({ kind: 'local', paths: f.paths });
    materializeBundle(resolveDeploymentPaths(f.home));
    expect(() => resolveSignInTarget(undefined, f.home)).toThrow(/--target/);
    expect(resolveSignInTarget('local', f.home).kind).toBe('local');
  });

  it('refuses a serving volume before opening GitHub or changing secrets', async () => {
    const f = fixture();
    const before = readFileSync(f.paths.secretsFile, 'utf8');
    const serving = await new LocalVolume(f.paths).serve(servingVolume(f.paths));
    let opened = false;
    try {
      await expect(registerGitHubApp({ url: f.url, target: { kind: 'local', paths: f.paths },
        openUrl: async () => { opened = true; } })).rejects.toThrow(/volume is in use/);
      expect(opened).toBe(false);
      expect(readFileSync(f.paths.secretsFile, 'utf8')).toBe(before);
    } finally { await serving.stop(); }
  });

  it('holds the volume through registration, preserves generated keys and reports pending start', async () => {
    const f = fixture();
    const before = readLocalSecrets(f.paths);
    let pageOpened!: (page: string) => void;
    const page = new Promise<string>((resolve) => { pageOpened = resolve; });
    const requests: string[] = [];
    const pending = registerGitHubApp({ url: f.url, target: { kind: 'local', paths: f.paths },
      openUrl: async (url) => { pageOpened(url); },
      fetchImpl: (async (input) => {
        requests.push(String(input));
        return Response.json({ client_id: 'Iv1.native', client_secret: 'native-secret', slug: 'native',
          name: 'Native', html_url: 'https://github.com/apps/native' }, { status: 201 });
      }) as typeof fetch });
    const pageUrl = await page;
    const html = await (await fetch(pageUrl)).text();
    expect(() => new LocalVolume(f.paths).exclusive(() => {})).toThrow(/volume is in use/);
    const state = /state=([A-Za-z0-9_%-]+)/.exec(html)![1];
    await fetch(`${new URL(pageUrl).origin}/callback?code=native&state=${state}`);
    const result = await pending;
    expect(result.verified).toMatchObject({ ok: false, pendingStart: true });
    expect(requests).toEqual(['https://api.github.com/app-manifests/native/conversions']);
    expect(readLocalSecrets(f.paths)).toEqual({ ...before, GITHUB_CLIENT_ID: 'Iv1.native', GITHUB_CLIENT_SECRET: 'native-secret' });
    expect(statSync(f.paths.secretsFile).mode & 0o777).toBe(0o600);
    expect(() => new LocalVolume(f.paths).exclusive(() => {})).not.toThrow();
  });

  it('refuses a different callback origin before registration', async () => {
    const f = fixture();
    await expect(registerGitHubApp({ url: 'https://different.example', target: { kind: 'local', paths: f.paths } })).rejects.toThrow(/origin/);
  });

  it('releases the volume after a timeout without changing existing credentials', async () => {
    const f = fixture();
    const before = readFileSync(f.paths.secretsFile, 'utf8');
    await expect(registerGitHubApp({ url: f.url, target: { kind: 'local', paths: f.paths }, timeoutMs: 20 })).rejects.toThrow();
    expect(readFileSync(f.paths.secretsFile, 'utf8')).toBe(before);
    expect(() => new LocalVolume(f.paths).exclusive(() => {})).not.toThrow();
  });

  it('reconfigures only the sign-in pair and refuses retained writers or malformed values', async () => {
    const f = fixture();
    const before = readLocalSecrets(f.paths);
    let retained!: Parameters<Parameters<typeof configureLocalSignIn>[1]>[0];
    await configureLocalSignIn(f.paths, async (install) => {
      retained = install;
      install({ clientId: 'Iv1.first', clientSecret: 'first' });
    });
    expect(() => retained({ clientId: 'Iv1.invalid', clientSecret: 'invalid' })).toThrow(/no longer holds/);
    await expect(configureLocalSignIn(f.paths, async (install) => {
      install({ clientId: 'Iv1.injected', clientSecret: 'bad\nSESSION_SECRET=bad' });
    })).rejects.toThrow(/single-line/);
    expect(readLocalSecrets(f.paths).GITHUB_CLIENT_ID).toBe('Iv1.first');
    await configureLocalSignIn(f.paths, async (install) => {
      install({ clientId: 'Iv1.second', clientSecret: 'second' });
    });
    expect(readLocalSecrets(f.paths)).toEqual({ ...before, GITHUB_CLIENT_ID: 'Iv1.second', GITHUB_CLIENT_SECRET: 'second' });
  });
});

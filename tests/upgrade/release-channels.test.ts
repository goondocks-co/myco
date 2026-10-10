import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { renderReleaseSelector, renderPowerShellReleaseSelector, selectChannelRelease } from '../../packages/myco/scripts/release-policy.mjs';
import { fetchMycoReleases, resolveMycoBinaryUpdateRefs } from '../../packages/myco/src/upgrade/release-resolver.js';
import { resolveMycoPackageCheck } from '../../packages/myco/src/upgrade/checker.js';
import { resolveNewestStagedVersion, checkAndStage } from '../../packages/myco/src/upgrade/auto-check.js';
import { readProjectReleaseChannel, writeProjectReleaseChannel } from '../../packages/myco/src/daemon/update-checker.js';
import { writeInstallMarker } from '../../packages/myco/src/install/managed-binary.js';
import { resolveTargetTriple, type GitHubRelease } from '../../packages/myco/src/upgrade/release-assets.js';
import type { ReleaseChannel } from '../../packages/myco/src/constants/update.js';

const triple = resolveTargetTriple();
const asset = `myco-${triple}`;
const release = (version: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: `myco/v${version}`, prerelease: version.includes('-'), draft: false,
  assets: [asset, 'SHA256SUMS'].map(name => ({ name, browser_download_url: `https://example.test/${version}/${name}` })), ...extra,
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-channel-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const source = fs.readFileSync(path.resolve('docs/install.sh'), 'utf8');
function shellPick(releases: GitHubRelease[], channel: ReleaseChannel, current = ''): string {
  const file = path.join(root, 'releases.json');
  fs.writeFileSync(file, JSON.stringify(releases, null, 2));
  const result = spawnSync('/bin/sh', [], {
    input: `${source.slice(0, source.lastIndexOf('main "$@"'))}\nPAGE_FILE='${file}'\nRELEASES_FILE='${file}.rows'\nASSET=${asset}\nrelease_rows > \"$RELEASES_FILE\"\npick_tag ${channel} '${current}'\n`,
    encoding: 'utf8', env: sandboxChildEnv(root),
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
const mixed = [
  release('2.0.0'), release('2.1.0-alpha.10'), release('2.1.0-alpha.2'), release('2.0.1-beta.10'), release('2.0.1-beta.2'),
  release('9.0.0-rc.1'), release('9.0.0', { draft: true }), release('9.0.0', { prerelease: true }),
  release('9.0.0-alpha.01'), release('9.0.0-alpha'), release('09.0.0'), release('9.0.0garbage'),
  release('9.0.0-beta.1+build'), release('9.0.0-beta.1', { assets: [] }),
  release('9.0.0', { tag_name: 'myco-shared/v9.0.0' }), release('1.4.8'),
];
const table: Array<[ReleaseChannel, string]> = [['stable', '2.0.0'], ['beta', '2.0.1-beta.10'], ['alpha', '2.1.0-alpha.10']];

describe('one channel policy for install and update', () => {
  it('commits the generated selector without drift', () => {
    expect(source).toContain(renderReleaseSelector());
    expect(fs.readFileSync(path.join(import.meta.dir, '../../docs/install.ps1'), 'utf8')).toContain(renderPowerShellReleaseSelector());
  });
  for (const [channel, expected] of table) {
    it(`${channel} selects ${expected} across mixed tags and input order`, async () => {
      for (const releases of [mixed, [...mixed].reverse()]) {
        // Move draft/prerelease before tag_name to exercise JSON field order.
        const shuffled = releases.map(r => ({ draft: r.draft, assets: r.assets, prerelease: r.prerelease, tag_name: r.tag_name }));
        expect(selectChannelRelease(shuffled, channel, { asset })?.tag_name).toBe(`myco/v${expected}`);
        expect(shellPick(shuffled, channel)).toBe(`myco/v${expected}`);
        const refs = await resolveMycoBinaryUpdateRefs(channel, { fetchReleases: async () => shuffled, targetTriple: () => triple }, '2.0.0-alpha.1');
        expect(refs?.targetVersion).toBe(expected);
        const check = await resolveMycoPackageCheck('2.0.0-alpha.1', channel, '2.0.0-alpha.1', async () => Response.json(shuffled));
        expect(check.latest_version).toBe(expected);
        expect(check.update_available).toBe(true);
      }
    });
  }
  it('reads later pages and refuses API failures rather than selecting a partial list', async () => {
    const first = Array.from({ length: 100 }, (_, i) => release(`2.0.0-alpha.${i + 1}`));
    const urls: string[] = [];
    const releases = await fetchMycoReleases(async url => { urls.push(String(url)); return Response.json(urls.length === 1 ? first : [release('2.0.0')]); });
    expect(releases).toHaveLength(101);
    expect(urls[1]).toContain('&page=2');
    expect(selectChannelRelease(releases, 'stable')?.tag_name).toBe('myco/v2.0.0');
    let call = 0;
    await expect(fetchMycoReleases(async () => ++call === 1 ? Response.json(first) : new Response('', { status: 503 }))).rejects.toThrow('503');
  });
  it('stable selects no prerelease; beta selects no alpha or rc', () => {
    const releases = [release('2.0.0-alpha.1'), release('2.0.0-beta.1'), release('2.0.0-rc.1')];
    expect(selectChannelRelease(releases, 'stable')).toBeNull();
    expect(shellPick(releases, 'stable')).toBe('');
    expect(selectChannelRelease(releases.slice(0, 1), 'beta')).toBeNull();
    expect(shellPick(releases.slice(0, 1), 'beta')).toBe('');
  });
  it('orders core components numerically before prerelease rank', () => {
    expect(shellPick([release('2.10.0'), release('2.9.99')], 'stable')).toBe('myco/v2.10.0');
    expect(selectChannelRelease([release('2.10.0'), release('2.9.99')], 'stable')?.tag_name).toBe('myco/v2.10.0');
  });
  it('stable wins above its own prereleases, and beta wins above alpha at the same base', () => {
    for (const channel of ['alpha', 'beta', 'stable'] as const) {
      const releases = [release('2.0.0-alpha.99'), release('2.0.0-beta.99'), release('2.0.0')];
      expect(shellPick(releases, channel)).toBe('myco/v2.0.0');
    }
    expect(shellPick([release('2.0.0-alpha.99'), release('2.0.0-beta.1')], 'alpha')).toBe('myco/v2.0.0-beta.1');
  });
  it('removing the newest alpha tag never downgrades an installed alpha machine', async () => {
    const current = '2.1.0-alpha.10';
    const remaining = mixed.filter(r => r.tag_name !== `myco/v${current}`);
    expect(selectChannelRelease(remaining, 'alpha', { asset, currentVersion: current })).toBeNull();
    expect(shellPick(remaining, 'alpha', current)).toBe('stay-put');
    expect(await resolveMycoBinaryUpdateRefs('alpha', { fetchReleases: async () => remaining, targetTriple: () => triple }, current)).toBeNull();
    const check = await resolveMycoPackageCheck(current, 'alpha', current, async () => Response.json(remaining));
    expect(check).toMatchObject({ latest_version: current, update_available: false, revert_available: false, staying_put: true });
  });
  it('a 1.4 updater cannot select a 2.x build', async () => {
    const releases = [release('1.4.8'), ...mixed];
    expect((await resolveMycoBinaryUpdateRefs('alpha', { fetchReleases: async () => releases, targetTriple: () => triple }, '1.4.8'))?.targetVersion).toBe('1.4.8');
    const check = await resolveMycoPackageCheck('1.4.8', 'beta', '1.4.8', async () => Response.json(releases));
    expect(check.update_available).toBe(false);
    expect(check.latest_version).toBe('1.4.8');
  });
  it('development builds resolve only 2.x, including stamped versions and the version fallback', async () => {
    for (const current of ['0.0.0-dev', '0.0.0-dev+1.4.8-412-gb173d920', '0.0.0']) {
      const deps = { fetchReleases: async () => [release('1.4.8'), release('2.0.0-beta.1')], targetTriple: () => triple };
      expect(shellPick(await deps.fetchReleases(), 'beta', current)).toBe('myco/v2.0.0-beta.1');
      expect(shellPick(await deps.fetchReleases(), 'stable', current)).toBe('');
      expect((await resolveMycoBinaryUpdateRefs('beta', deps, current))?.targetVersion).toBe('2.0.0-beta.1');
      expect(await resolveMycoBinaryUpdateRefs('stable', deps, current)).toBeNull();
      const check = await resolveMycoPackageCheck(current, 'stable', current, async () => Response.json(await deps.fetchReleases()));
      expect(check).toMatchObject({ latest_version: current, update_available: false, revert_available: false });
      expect(resolveNewestStagedVersion(root, 'darwin', current, undefined, p => !p.endsWith('.adopt-failed'),
        () => ['1.4.8', '2.0.0-beta.1'], 'beta')).toBe('2.0.0-beta.1');
    }
  });
  it('staged adoption obeys the selected channel even after switching it', () => {
    const entries = ['2.0.0', '2.0.1-beta.10', '2.1.0-alpha.10', '9.0.0-rc.1'];
    for (const [channel, expected] of table) {
      expect(resolveNewestStagedVersion(root, 'darwin', '2.0.0-alpha.1', undefined, p => !p.endsWith('.adopt-failed'), () => entries, channel)).toBe(expected);
    }
    expect(resolveNewestStagedVersion(root, 'darwin', '2.1.0-alpha.10', undefined, p => !p.endsWith('.adopt-failed'), () => entries, 'alpha')).toBeNull();
  });
  it('auto-stage reports an older eligible target and performs no download', async () => {
    let staged = false, reported = false;
    const result = await checkAndStage('2.1.0-alpha.10', { home: root, platform: 'darwin', channel: 'alpha',
      logger: { info: () => { reported = true; }, error: () => {} } as never }, {
      isManualChannel: () => false,
      resolveRefs: async () => ({ assetName: asset, assetUrl: '', sha256sumsUrl: '', targetVersion: '2.0.0' }),
      stageBinary: async () => { staged = true; return { version: '', versionDir: '' }; },
    });
    expect(result).toEqual({ status: 'noop', reason: 'older-release' });
    expect(staged).toBe(false); expect(reported).toBe(true);
  });
  it('uses the installed channel and records an explicit channel change', () => {
    const previousHome = process.env.MYCO_HOME;
    const home = path.join(root, 'channel-home');
    process.env.MYCO_HOME = home;
    const config = path.join(home, 'config.yaml'), marker = path.join(home, 'install.json');
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(config, 'daemon:\n  update_channel: beta\n');
      writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: path.join(home, 'bin/myco') });
      expect(readProjectReleaseChannel()).toBe('alpha');
      writeProjectReleaseChannel(undefined, 'stable');
      expect(readProjectReleaseChannel()).toBe('stable');
      expect(JSON.parse(fs.readFileSync(marker, 'utf8')).channel).toBe('stable');
      expect(fs.readFileSync(config, 'utf8')).toBe('daemon:\n  update_channel: beta\n');
      const rename = fs.renameSync;
      const failedPublish = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === marker) throw new Error('marker publication refused');
        return rename(from, to);
      });
      try { expect(() => writeProjectReleaseChannel(undefined, 'alpha')).toThrow('marker publication refused'); }
      finally { failedPublish.mockRestore(); }
      expect(readProjectReleaseChannel()).toBe('stable');
      expect(fs.readFileSync(config, 'utf8')).toBe('daemon:\n  update_channel: beta\n');
      expect(JSON.parse(fs.readFileSync(marker, 'utf8')).channel).toBe('stable');
      const read = fs.readFileSync;
      const unreadable = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(file) === marker) throw Object.assign(new Error('marker unreadable'), { code: 'EACCES' });
        return Reflect.apply(read, fs, [file, ...args]);
      }) as typeof fs.readFileSync);
      try { expect(() => readProjectReleaseChannel()).toThrow('marker unreadable'); }
      finally { unreadable.mockRestore(); }
      fs.writeFileSync(marker, '{broken');
      expect(() => readProjectReleaseChannel()).toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
    }
  });
});

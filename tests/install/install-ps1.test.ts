/** The Windows installer's real classification and release selection, with fixture GitHub responses. */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { beforeGa, PWSH, release, removeInstallRoot, select } from './install-ps1-fixture.js';

afterAll(() => removeInstallRoot());

describe('the Windows installer', () => {
  it.skipIf(PWSH === '' || process.platform === 'win32')('replaces npm-origin 1.4 and 2.x alphas through the native installer', () => {
    for (const current of ['1.4.9', '2.0.0-alpha.12']) {
      const run = select(beforeGa, { current, npmOrigin: true, evidence: 'slot', replace: current.startsWith('1.'), install: '2.0.0-beta.2', channel: 'alpha' });
      expect(run.status, run.out).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8'))).toMatchObject({
        source: 'curl', version: '2.0.0-beta.2', bin: run.exe,
      });
      if (current.startsWith('1.')) {
        const record = JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'legacy-executable.json'), 'utf8'));
        expect(fs.readFileSync(record.path)).toEqual(run.before!);
      }
    }
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('announces replacement of a recorded source build with a release', () => {
    const replaced = select([release('2.0.0')], { current: '0.0.0-dev+fixture.b1', sourceCheckout: true, install: '2.0.0' });
    expect(replaced.status).toBe(0);
    expect(replaced.out).toContain('Replacing this source build with the selected channel release.');
    expect(JSON.parse(fs.readFileSync(path.join(replaced.mycoHome, 'install.json'), 'utf8')).source).toBe('curl');
  });

  it.skipIf(PWSH === '')('fresh default chooses beta before alpha, then stable after GA', () => {
    expect(select(beforeGa).out).toContain('Found: myco/v2.0.0-beta.2');
    expect(select([...beforeGa, release('2.1.0-alpha.99')]).out).toContain('Found: myco/v2.0.0-beta.2');
    expect(select([release('1.4.9'), release('2.0.0-alpha.2'), release('2.0.0-alpha.10')]).out).toContain('Found: myco/v2.0.0-alpha.10');
    expect(select([...beforeGa, release('2.0.0'), release('2.1.0-beta.1')]).out).toContain('Found: myco/v2.0.0');
  });

  it.skipIf(PWSH === '')('fresh machines never fall back to 1.x, including explicit stable and beta', () => {
    for (const channel of [undefined, 'stable', 'beta']) {
      const run = select([release('1.4.9')], { channel });
      expect(run.status).not.toBe(0);
      expect(run.out).not.toContain('Found: myco/v1.');
    }
    expect(select(beforeGa, { channel: 'stable' }).status).not.toBe(0);
    expect(select(beforeGa, { channel: 'alpha' }).out).toContain('Found: myco/v2.0.0-beta.2');
  });

  it.skipIf(PWSH === '')('existing 1.x stays on 1.x after GA; explicit replacement selects 2.x', () => {
    const releases = [...beforeGa, release('2.0.0')];
    expect(select(releases, { current: '1.4.8' }).out).toContain('Found: myco/v1.4.9');
    expect(select(releases, { current: '1.4.8', channel: 'beta' }).status).not.toBe(0);
    expect(select(beforeGa, { current: '1.4.8', replace: true }).out).toContain('Found: myco/v2.0.0-beta.2');
    for (const evidence of ['marker', 'slot'] as const) {
      expect(select(releases, { current: '1.4.8', evidence }).out).toContain('Found: myco/v1.4.9');
    }
  });

  it.skipIf(PWSH === '')('preserves unknown binaries, member homes, cutovers, links and empty files without selecting 1.x', () => {
    for (const state of [undefined, 'member', 'cutover', 'symlink', 'empty', 'vault'] as const) {
      const run = select(beforeGa, { current: '2.0.0-alpha.1', evidence: 'unknown', state, install: process.platform === 'win32' ? undefined : '1.4.9' });
      expect(run.status).not.toBe(0);
      expect(run.out).toContain(`unclassifiable binary`);
      expect(run.out).toContain(run.exe);
      expect(run.out).toContain('--replace-1.4');
      expect(run.out).toContain('https://myco.sh/install.');
      expect(run.out).not.toContain('Found: myco/v1.');
      expect(fs.readFileSync(run.exe)).toEqual(run.before!);
      expect(fs.lstatSync(run.exe).isSymbolicLink()).toBe(state === 'symlink');
      if (state === 'symlink') expect(fs.readlinkSync(run.exe)).toBe(run.linkBefore!);
    }
  });

  it.skipIf(PWSH === '')('never selects 1.x in a member or cutover home even with positive 1.x evidence', () => {
    for (const state of ['member', 'cutover'] as const) {
      const run = select(beforeGa, { current: '1.4.8', state });
      expect(run.status).not.toBe(0);
      expect(run.out).not.toContain('Found: myco/v1.');
      expect(fs.readFileSync(run.exe)).toEqual(run.before!);
    }
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('replaces an unknown binary only with explicit consent and updates vault-only 1.4 homes', () => {
    const replaced = select(beforeGa, { current: 'unknown', evidence: 'unknown', replace: true, install: '2.0.0-beta.2' });
    expect(replaced.status).toBe(0);
    expect(replaced.out).toContain('Found: myco/v2.');
    expect(replaced.out).not.toContain('Found: myco/v1.');
    const legacy = select(beforeGa, { state: 'vault', install: '1.4.9' });
    expect(legacy.status).toBe(0);
    expect(legacy.out).toContain('Myco 1.4 was updated');
    expect(fs.existsSync(path.join(legacy.mycoHome, 'commands.log'))).toBe(false);
  });

  it.skipIf(PWSH === '')('classifies development-version slots without executing them', () => {
    for (const current of ['0.0.0-dev', '0.0.0-dev+abc123']) {
      const run = select(beforeGa, { current, evidence: 'slot', channel: 'alpha' });
      expect(run.status).toBe(0);
      expect(run.out).toContain('Found: myco/v2.0.0-beta.2');
    }
  });

  it.skipIf(PWSH === '')('refuses explicit 2.x network selection over 1.4 with replacement guidance', () => {
    const run = select(beforeGa, { current: '1.4.8', channel: 'alpha' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('Nothing was installed');
    expect(run.out).toContain('-Replace14');
    expect(run.out.replace(/\n\s*\|\s*/g, ' ').replace(/\s+/g, ' ')).toContain('then run myco setup --cutover. Manual path: myco login <your-myco-address>, then myco cutover --dry-run (changes nothing).');
    expect(run.out).not.toContain('Found: myco/v1.');
    expect(fs.readFileSync(run.exe)).toEqual(run.before!);
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('launch checks isolate every configuration home under the probe home', () => {
    const run = select(beforeGa, { install: '2.0.0-beta.2', probe: true });
    expect(run.status).toBe(0);
    const homes = Object.fromEntries(fs.readFileSync(path.join(run.home, 'probe-env.log'), 'utf8').trim().split('\n').map(line => line.split('=')));
    expect(homes.HOME).toStartWith(path.join(run.home, 'bin/.myco-install-'));
    expect(path.basename(homes.HOME!)).toBe('probe-home');
    for (const key of ['HOME', 'MYCO_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
      const relative = path.relative(homes.HOME!, homes[key]!);
      expect(homes[key]).not.toBe('');
      expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))).toBe(true);
    }
  });

  it.skipIf(PWSH === '')('a stale 1.4 marker cannot downgrade the live 2.x binary', () => {
    const run = select([...beforeGa, release('2.0.0')], { current: '2.0.0-beta.2', stale: true });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Found: myco/v2.0.0');
    expect(run.out).not.toContain('Found: myco/v1.');
    const beforeStable = select(beforeGa, { current: '2.0.0-beta.2', stale: true, install: process.platform === 'win32' ? undefined : '2.0.0-beta.2' });
    expect(beforeStable.status).toBe(0);
    expect(beforeStable.out).toContain('Found: myco/v2.0.0-beta.2');
    if (process.platform !== 'win32') expect(JSON.parse(fs.readFileSync(path.join(beforeStable.mycoHome, 'install.json'), 'utf8')).channel).toBe('beta');
  });

  it.skipIf(PWSH === '')('keeps the recorded preview channel across an interrupted 2.x update', () => {
    const run = select([...beforeGa, release('2.1.0-alpha.99')], {
      current: '2.0.0-beta.2', stale: true, staleVersion: '2.0.0-alpha.1', staleChannel: 'alpha',
    });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Found: myco/v2.1.0-alpha.99');
  });

  it.skipIf(PWSH === '')('preserves recorded channels and refuses downgrades', () => {
    const run = select(beforeGa, { current: '2.0.0-beta.10', channel: 'beta' });
    expect(run.status).toBe(0);
    expect(run.out).toContain('staying put');
    expect(select(beforeGa, { current: '2.0.0-alpha.1', channel: 'alpha' }).out).toContain('Found: myco/v2.0.0-beta.2');
  });

  it.skipIf(PWSH === '')('uses shared numeric semver and rejects drafts, malformed tags, RCs and incomplete assets', () => {
    const bad = [release('9.0.0garbage'), release('9.0.0-rc.1'), release('9.0.0', { draft: true }),
      release('9.1.0', { prerelease: true }), release('9.2.0', { assets: [] }), release('09.0.0')];
    expect(select([...beforeGa, ...bad, release('2.0.0-beta.10')], { channel: 'beta' }).out).toContain('Found: myco/v2.0.0-beta.10');
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('reuses an identical Windows legacy slot', () => {
    const run = select(beforeGa, { current: '1.4.8', evidence: 'slot', replace: true, install: '2.0.0-beta.2' });
    expect(run.status).toBe(0);
    const record = JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'legacy-executable.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(record.path).toBe(path.join(path.dirname(run.exe), 'versions', '1.4.8', 'myco.exe'));
    expect(fs.existsSync(path.join(path.dirname(run.exe), 'legacy'))).toBe(false);
  });


  it.skipIf(PWSH === '' || process.platform === 'win32')('never publishes a truncated Windows preservation copy into a slot', () => {
    const run = select(beforeGa, { current: '1.4.8', replace: true, install: '2.0.0-beta.2', truncatePreserve: true });
    expect(run.status).not.toBe(0); expect(run.out).toContain('does not match');
    expect(fs.readFileSync(run.exe)).toEqual(run.before!);
    expect(fs.existsSync(path.join(path.dirname(run.exe), 'versions', '1.4.8', 'myco.exe'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(run.exe), 'versions', '2.0.0-beta.2'))).toBe(false);
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('keeps the Windows copy and installation if publishing its record fails', () => {
    const run = select(beforeGa, { current: '1.4.8', replace: true, install: '2.0.0-beta.2', failRecord: true });
    expect(run.status).toBe(0); expect(run.out).toContain('but could not record it');
    expect(fs.readFileSync(path.join(path.dirname(run.exe), 'versions', '1.4.8', 'myco.exe'))).toEqual(run.before!);
    expect(fs.readFileSync(run.exe)).not.toEqual(run.before!);
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('installs fixture releases and only refreshes a joined 2.x member', () => {
    for (const scenario of [
      { install: '2.0.0-beta.2' },
      { install: '2.0.0-beta.2', current: '1.4.8', replace: true },
      { install: '2.0.0-beta.2', joined: true },
      { install: '1.4.9', current: '1.4.8' },
    ]) {
      const run = select(beforeGa, scenario);
      expect({ scenario, status: run.status, out: run.status ? run.out : '' }).toEqual({ scenario, status: 0, out: '' });
      const marker = JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8'));
      expect(marker).toMatchObject({ version: scenario.install, channel: scenario.install.startsWith('1.') ? 'stable' : 'beta' });
      const commands = path.join(run.mycoHome, 'commands.log');
      if (scenario.joined) expect(fs.readFileSync(commands, 'utf8')).toBe('member provision --refresh\n');
      else expect(fs.existsSync(commands)).toBe(false);
      if (scenario.install.startsWith('1.')) {
        expect(run.out).toContain('To move to 2.0:');
        expect(run.out).toContain('--replace-1.4');
        expect(run.out).not.toContain('myco login');
        expect(run.out).not.toContain('myco server create');
        expect(run.out).toContain('After installing 2.0, guide the move with:\n    myco setup --cutover');
        expect(run.out).not.toContain('invite link');
      }
      if (scenario.replace) {
        expect(run.out).toContain("  To guide the move to 2.0, run:\n    myco setup --cutover\n  Setup can also run Myco's work on an always-on machine (a runner).\n  Manual path: myco login <your-myco-address>, then myco cutover --dry-run (changes nothing).");
      }
      if (!scenario.joined) {
        expect(run.out).not.toContain('`');
        expect(run.out).toMatch(/^    myco setup(?: --cutover)?$/m);
      }
      if (!scenario.current && !scenario.joined) {
        expect(run.out).toContain("  Run:\n    myco setup\n  Choose to start your own Myco, join one, or run Myco's work\n  on an always-on machine (a runner).");
      }
    }
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('keeps a completed install and gives a retry when joined-member refresh fails', () => {
    const run = select(beforeGa, { install: '2.0.0-beta.2', joined: true, refreshFailure: true });
    expect(run.status).toBe(0);
    expect(run.out).toContain('Refresh failed');
    expect(run.out).toContain('Run: myco member provision --refresh');
    expect(JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8')).channel).toBe('beta');
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('refuses an exit-zero artifact that reports another version', () => {
    const run = select([release('2.0.0-beta.2')], { install: '2.0.0-beta.1' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('did not report the selected version');
    expect(fs.existsSync(path.join(run.mycoHome, 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(run.home, 'bin', 'myco.exe'))).toBe(false);
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('installs the build for the machine, ARM64 even from emulated x64 PowerShell, only against its checksum, and nothing when the machine is unknown', () => {
    for (const [arch, asset] of [['ARM64', 'arm64'], ['x64-emulated-on-ARM64', 'arm64'], ['registry-unreadable-on-ARM64', 'arm64'], ['AMD64', 'x64']] as const) {
      const run = select([release('2.0.0')], { arch, install: '2.0.0' });
      expect({ status: run.status, agents: [...new Set(run.sentUserAgents)] }).toEqual({ status: 0, agents: ['myco-installer/goondocks-co'] });
      expect(run.out).toContain(`Downloading myco-windows-${asset}.exe`);
      expect(JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'install.json'), 'utf8')).version).toBe('2.0.0');
    }
    for (const [arch, refusal] of [['ARM64', "Asset 'myco-windows-arm64.exe' not found in SHA256SUMS."], ['undeterminable', "Could not determine this machine's processor architecture; nothing was installed."]] as const) {
      const refused = select([release('2.0.0')], { arch, install: '2.0.0', sumsName: 'myco-windows-x64.exe' });
      expect([refused.status === 0, refused.out.includes(refusal), fs.existsSync(refused.exe)]).toEqual([false, true, false]);
    }
  });

  it.skipIf(PWSH === '')('selects on ARM64 only releases that carry the ARM64 asset, and never updates 1.4 there', () => {
    const x64Only = release('2.0.0', { assets: [{ name: 'myco-windows-x64.exe' }, { name: 'SHA256SUMS' }] });
    expect(select([x64Only, release('2.0.0-beta.2')], { arch: 'ARM64' }).out).toContain('Found: myco/v2.0.0-beta.2');
    expect(select([x64Only, release('2.0.0-beta.2')], { arch: 'AMD64' }).out).toMatch(/Found: myco\/v2\.0\.0\r?$/m);
    const legacy = select([...beforeGa, release('2.0.0')], { arch: 'ARM64', current: '1.4.8' });
    expect([legacy.status === 0, legacy.out.includes('Found: myco/v1.')]).toEqual([false, false]);
    expect(legacy.out).toContain('Myco 1.4 is on this machine. Nothing was installed.');
  });

});

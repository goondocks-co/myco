/**
 * `docs/install.sh`, the Myco 2.0 installer, run for real in a temporary HOME.
 *
 * The binary it installs is a tiny compiled stand-in served from a local
 * directory (`MYCO_INSTALL_FROM`), so the whole flow runs, checksum and
 * macOS signature check included, with no network. GitHub release resolution
 * is exercised through a `curl` on PATH that answers with a fixed releases
 * list, with and without `jq`.
 *
 * What it is judged by: a first-time install places the binary, PATH and the
 * install marker, starts nothing, and points at `myco login`; on a machine
 * with Myco 1.4 it installs nothing unless asked with --replace-1.4, says how
 * to move over, and never moves or deletes anything of 1.4; a dry run says
 * which it would do and changes nothing; a binary that fails its checksum,
 * is missing from SHA256SUMS or does not run is never installed; only a
 * well-formed, non-draft Myco 2.x tag is chosen, in semver order, a
 * prerelease only while no 2.x release exists (or on the beta channel), and
 * with no 2.x at all it says 2.0 is not released yet; every request is
 * HTTPS-only; a script cut short runs nothing; the 1.4 `--serve` option is
 * refused.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dir, '..', '..', 'docs', 'install.sh');
const TARGET = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const HAS_CC = spawnSync('sh', ['-c', 'command -v cc'], { encoding: 'utf8' }).status === 0;

/** The tools the installer uses, linked into one directory: a PATH with exactly these on it. */
function toolbox(dir: string, opts: { jq: boolean; curl?: string }): string {
  fs.mkdirSync(dir, { recursive: true });
  const tools = ['sh', 'uname', 'mktemp', 'sed', 'grep', 'awk', 'sort', 'head', 'tail', 'cut', 'tr', 'cat', 'rm', 'mkdir', 'mv', 'cp', 'chmod', 'sleep', 'kill',
    'sha256sum', 'shasum', 'codesign', 'xattr', 'perl', ...(opts.jq ? ['jq'] : []), ...(opts.curl ? [] : ['curl'])];
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(dir, tool));
  }
  if (opts.curl) { fs.writeFileSync(path.join(dir, 'curl'), opts.curl); fs.chmodSync(path.join(dir, 'curl'), 0o755); }
  return dir;
}

/** A `curl` that writes `releases` to its -o file and reports HTTP 200, and fails any download; `log` records each call's arguments. */
const releasesCurl = (releases: unknown, file: string, opts: { pretty?: boolean; log?: string } = {}): string => {
  fs.writeFileSync(file, opts.pretty ? JSON.stringify(releases, null, 2) : JSON.stringify(releases));
  return `#!/bin/sh\n${opts.log ? `echo "$*" >> '${opts.log}'\n` : ''}out=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; *) shift ;; esac; done\n`
    + `[ -n "$out" ] || exit 22\ncp '${file}' "$out"\nprintf 200\n`;
};

interface Run { status: number | null; out: string; home: string }

function install(home: string, env: Record<string, string>, args: string[] = [], toolPath?: string): Run {
  const result = spawnSync('sh', [SCRIPT, ...args], {
    env: { PATH: toolPath ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, ...env }, encoding: 'utf8', timeout: 90_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''), home };
}

/** Every file under `dir`, relative to it. */
const files = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : []);

let artifacts: string;
/** Install sources: a good build, one whose bytes no longer match SHA256SUMS, one SHA256SUMS does not list, and one that does not run. */
const sources = { tampered: '', unlisted: '', broken: '' };
beforeAll(() => {
  artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-artifacts-'));
  if (!HAS_CC) return;
  const build = (dir: string, body: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'stand-in.c');
    fs.writeFileSync(source, `#include <stdio.h>\nint main(void) { ${body} }\n`);
    const binary = path.join(dir, `myco-${TARGET}`);
    expect(spawnSync('cc', ['-o', binary, source]).status).toBe(0);
    fs.rmSync(source);
    return binary;
  };
  const sums = (binary: string, name = `myco-${TARGET}`): void => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    fs.writeFileSync(path.join(path.dirname(binary), 'SHA256SUMS'), `${sha}  ${name}\n`);
  };
  sums(build(artifacts, 'puts("2.0.0-beta.1"); return 0;'));
  sources.tampered = path.join(artifacts, 'tampered');
  const tampered = build(sources.tampered, 'puts("2.0.0-beta.1"); return 0;');
  sums(tampered);
  fs.appendFileSync(tampered, 'changed after signing the sums');
  sources.unlisted = path.join(artifacts, 'unlisted');
  sums(build(sources.unlisted, 'puts("2.0.0-beta.1"); return 0;'), 'myco-plan9-x64');
  sources.broken = path.join(artifacts, 'broken');
  sums(build(sources.broken, 'return 1;'));
});

const freshHome = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-home-')));
const FROM = () => ({ MYCO_INSTALL_FROM: artifacts, MYCO_INSTALL_VERSION: '2.0.0-beta.1' });

/** A home Myco 1.4 set up: a vault, and optionally its binary where 2.0 goes. */
function legacyHome(opts: { binary: boolean }): { home: string; vault: string; binary: string } {
  const home = freshHome();
  const vault = path.join(home, '.myco', 'groves', 'grove_a', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  fs.writeFileSync(vault, 'a 1.4 vault');
  const binary = path.join(home, '.myco', 'bin', 'myco');
  if (opts.binary) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\necho 1.4.8\n');
    fs.chmodSync(binary, 0o755);
  }
  return { home, vault, binary };
}

describe('the Myco 2.0 installer', () => {
  it.skipIf(!HAS_CC)('installs the binary for a first-time user, starts nothing, and points at `myco login`', () => {
    const home = freshHome();
    const run = install(home, FROM());
    expect(run.status).toBe(0);
    expect(files(home)).toEqual(['.myco/bin/myco', '.myco/bin/versions/2.0.0-beta.1/myco', '.myco/install.json', '.zshenv']);
    expect(spawnSync(path.join(home, '.myco', 'bin', 'myco'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.1');
    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf8')).toContain(`export PATH="${path.join(home, '.myco', 'bin')}:$PATH"`);
    expect(run.out).toContain('Myco 2.0.0-beta.1 installed to');
    expect(run.out).toContain('myco login <invite link>');
    expect(run.out).toContain('docs/self-hosting.md');
    expect(run.out).not.toContain('cutover');
    expect(run.out).not.toContain('service install');
    // A second run changes nothing it already set up.
    const zshenv = fs.readFileSync(path.join(home, '.zshenv'), 'utf8');
    expect(install(home, FROM()).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf8')).toBe(zshenv);
  });

  it.skipIf(!HAS_CC)('puts its bin directory on PATH in a .bash_profile that exists', () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, '.bash_profile'), '# mine\n');
    expect(install(home, FROM()).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toContain(`export PATH="${path.join(home, '.myco', 'bin')}:$PATH"`);
  });

  describe('on a machine with Myco 1.4', () => {
    it('installs nothing by default, over a 1.x binary or beside 1.4 vaults, and says how to move over', () => {
      for (const binary of [true, false]) {
        const legacy = legacyHome({ binary });
        const before = files(legacy.home);
        const run = install(legacy.home, FROM());
        expect({ binary, status: run.status }).toEqual({ binary, status: 1 });
        expect(run.out).toContain(binary
          ? `Myco 1.4 is on this machine (its binary ${legacy.binary}, 1.4.8). Nothing was installed.`
          : `Myco 1.4 is on this machine (its vaults in ${path.join(legacy.home, '.myco', 'groves')}). Nothing was installed.`);
        expect(run.out).toContain("curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh -s -- --replace-1.4");
        expect(run.out).toContain('myco cutover --dry-run');
        expect(run.out).toContain('docs/upgrade.md');
        expect(files(legacy.home)).toEqual(before);
        if (binary) expect(fs.readFileSync(legacy.binary, 'utf8')).toBe('#!/bin/sh\necho 1.4.8\n');
      }
    });

    it.skipIf(!HAS_CC)('takes 1.4\'s place when asked, by flag or by env, and moves nothing of 1.4', () => {
      for (const [env, args] of [[{}, ['--replace-1.4']], [{ MYCO_REPLACE_LEGACY: '1' }, []]] as const) {
        const legacy = legacyHome({ binary: true });
        const run = install(legacy.home, { ...FROM(), ...env }, [...args]);
        expect(run.status).toBe(0);
        expect(spawnSync(legacy.binary, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.1');
        expect(run.out).toContain('2.0 took its place, so 1.4 captures nothing until you move over.');
        expect(run.out).toContain('myco cutover --dry-run');
        expect(fs.readFileSync(legacy.vault, 'utf8')).toBe('a 1.4 vault');
        expect(files(path.join(legacy.home, '.myco')).filter((f) => !f.startsWith('bin/') && f !== 'install.json')).toEqual(['groves/grove_a/myco.db']);
      }
    });

    it.skipIf(!HAS_CC)('installs as usual in a home a cutover already moved to 2.0', () => {
      const legacy = legacyHome({ binary: false });
      fs.mkdirSync(path.join(legacy.home, '.myco', 'member'), { recursive: true });
      fs.writeFileSync(path.join(legacy.home, '.myco', 'member', 'cutover.json'), '{}');
      const run = install(legacy.home, FROM());
      expect(run.status).toBe(0);
      expect(run.out).toContain('Myco 2.0.0-beta.1 installed to');
    });

    it('says on a dry run which of the two it would do, and changes nothing', () => {
      const legacy = legacyHome({ binary: true });
      const before = files(legacy.home);
      const refused = install(legacy.home, FROM(), ['--dry-run']);
      expect(refused.status).toBe(0);
      expect(refused.out).toContain('Myco 1.4 is on this machine');
      expect(refused.out).toContain('so it would install nothing.');
      expect(refused.out).not.toContain('Would install');
      const replaced = install(legacy.home, FROM(), ['--dry-run', '--replace-1.4']);
      expect(replaced.out).toContain('Would install');
      expect(replaced.out).toContain('--replace-1.4 was given, so 2.0 would take its place');
      expect(files(legacy.home)).toEqual(before);
    });
  });

  describe('installs nothing it cannot trust', () => {
    const cases = [
      ['a binary whose bytes do not match SHA256SUMS', 'tampered', 'Checksum mismatch for'],
      ['a binary SHA256SUMS does not list', 'unlisted', 'not found in SHA256SUMS; nothing was installed.'],
      ['a binary that does not run here', 'broken', 'The downloaded binary does not run on this machine; nothing was installed.'],
    ] as const;
    for (const [what, source, message] of cases) {
      it.skipIf(!HAS_CC)(what, () => {
        const home = freshHome();
        const run = install(home, { MYCO_INSTALL_FROM: sources[source], MYCO_INSTALL_VERSION: '2.0.0-beta.1' });
        expect(run.status).toBe(1);
        expect(run.out).toContain(message);
        expect(files(home)).toEqual([]);
      });
    }
  });

  it('changes nothing on a dry run', () => {
    const home = freshHome();
    const run = install(home, FROM(), ['--dry-run']);
    expect(run.status).toBe(0);
    expect(run.out).toContain('Dry run: nothing was downloaded or changed.');
    expect(files(home)).toEqual([]);
  });

  it('runs nothing when the download is cut short', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    expect(script.trimEnd().split('\n').at(-1)).toBe('main "$@"');
    const cut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-cut-')), 'install.sh');
    fs.writeFileSync(cut, script.slice(0, script.lastIndexOf('main "$@"')));
    const home = freshHome();
    const result = spawnSync('sh', [cut], { env: { PATH: '/usr/bin:/bin', HOME: home, ...FROM() }, encoding: 'utf8' });
    expect({ status: result.status, out: `${result.stdout}${result.stderr}` }).toEqual({ status: 0, out: '' });
    expect(files(home)).toEqual([]);
  });

  it('refuses the Myco 1.4 Team Host option and points at self-hosting', () => {
    const run = install(freshHome(), {}, ['--serve']);
    expect(run.status).toBe(1);
    expect(run.out).toContain('docs/self-hosting.md');
  });

  describe('chooses only Myco 2.x from the GitHub releases', () => {
    const release = (tag: string, prerelease = false, draft = false) => ({ tag_name: tag, prerelease, draft });
    const beforeGa = [release('myco/v1.4.8'), release('myco/v1.4.9-beta.1', true), release('myco/v2.0.0-beta.1', true), release('myco-shared/v2.0.0')];
    const afterGa = [...beforeGa, release('myco/v2.0.0'), release('myco/v2.1.0-beta.1', true)];
    for (const jq of [true, false]) {
      describe(jq ? 'with jq' : 'without jq', () => {
        const pick = (releases: unknown[], channel: string, opts: { pretty?: boolean; log?: string; args?: string[] } = {}): Run => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-tools-'));
          const tools = toolbox(path.join(dir, 'bin'), { jq, curl: releasesCurl(releases, path.join(dir, 'releases.json'), opts) });
          return install(freshHome(), { MYCO_CHANNEL: channel }, opts.args ?? ['--dry-run'], tools);
        };
        it('a release over a prerelease, and a prerelease only while no release exists or on beta', () => {
          const stableBeforeGa = pick(beforeGa, 'stable');
          expect(stableBeforeGa.status).toBe(0);
          expect(stableBeforeGa.out).toContain('No Myco 2 release yet; installing the newest prerelease, myco/v2.0.0-beta.1.');
          expect(stableBeforeGa.out).toContain(`Would install myco-${TARGET} (2.0.0-beta.1) from https://github.com/goondocks-co/myco/releases/download/myco%2Fv2.0.0-beta.1`);
          expect(pick(beforeGa, 'beta').out).toContain('Found: myco/v2.0.0-beta.1');
          expect(pick(afterGa, 'stable').out).toContain('Found: myco/v2.0.0');
          expect(pick(afterGa, 'stable').out).not.toContain('prerelease');
          expect(pick(afterGa, 'beta').out).toContain('Found: myco/v2.1.0-beta.1');
          expect(pick(afterGa, 'beta', { pretty: true }).out).toContain('Found: myco/v2.1.0-beta.1');
        });
        it('in semver order: a release above its prereleases, numeric parts as numbers', () => {
          const found = (tags: Array<[string, boolean]>) => pick(tags.map(([t, p]) => release(t, p)), 'beta').out.match(/Found: (\S+)/)?.[1];
          expect(found([['myco/v2.0.0', false], ['myco/v2.0.0-beta.1', true]])).toBe('myco/v2.0.0');
          expect(found([['myco/v2.0.0-beta.1', true], ['myco/v2.0.0', false]])).toBe('myco/v2.0.0');
          expect(found([['myco/v2.0.0-beta.10', true], ['myco/v2.0.0-beta.2', true]])).toBe('myco/v2.0.0-beta.10');
          expect(found([['myco/v2.0.0-rc.1', true], ['myco/v2.0.0-beta.9', true]])).toBe('myco/v2.0.0-rc.1');
          expect(found([['myco/v2.10.0', false], ['myco/v2.9.0', false]])).toBe('myco/v2.10.0');
        });
        it('never a draft', () => {
          const run = pick([...afterGa, release('myco/v2.2.0', false, true)], 'stable');
          expect(run.out).toContain('Found: myco/v2.0.0');
        });
        it('never a malformed tag', () => {
          const malformed = ['myco/v9.0.0garbage', 'myco/v9.0.0-beta.1+build', 'myco/v9.0', 'xmyco/v9.0.0', 'myco/v9.0.0.1', 'myco/v9.0.0-', 'myco/v9x0x0'];
          const run = pick([...afterGa, ...malformed.map((t) => release(t))], 'beta');
          expect(run.out).toContain('Found: myco/v2.1.0-beta.1');
        });
        it('says Myco 2.0 is not released yet, and exits non-zero, when no 2.x exists', () => {
          const onlyOld = pick([release('myco/v1.4.8'), release('myco/v1.5.0-beta.1', true), release('myco/v2.0.0', false, true)], 'beta');
          expect(onlyOld.status).toBe(1);
          expect(onlyOld.out).toContain('No Myco 2.x release found: Myco 2.0 has not been released yet, so there is nothing to install.');
          expect(onlyOld.out).toContain('https://github.com/goondocks-co/myco/releases');
        });
        it('reaches GitHub over HTTPS and TLS 1.2 or newer only', () => {
          const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-curl-')), 'calls');
          pick(afterGa, 'stable', { log, args: [] });
          const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
          expect(calls.length).toBe(3);
          for (const call of calls) expect(call).toContain('--proto =https --tlsv1.2 ');
        });
      });
    }
  });

  it.skipIf(spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).status !== 0)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

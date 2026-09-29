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
 * install marker, starts nothing, and points at `myco login`; a machine with
 * Myco 1.4 is told so and pointed at `myco cutover --dry-run`, and nothing of
 * 1.4 is moved; a dry run changes nothing; only Myco 2.x is ever chosen, a
 * prerelease only while no 2.x release exists (or on the beta channel); the
 * 1.4 `--serve` option is refused.
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
  const tools = ['sh', 'uname', 'mktemp', 'sed', 'grep', 'awk', 'sort', 'head', 'cat', 'rm', 'mkdir', 'mv', 'cp', 'chmod', 'sleep', 'kill',
    'sha256sum', 'shasum', 'codesign', 'xattr', 'perl', ...(opts.jq ? ['jq'] : []), ...(opts.curl ? [] : ['curl'])];
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(dir, tool));
  }
  if (opts.curl) { fs.writeFileSync(path.join(dir, 'curl'), opts.curl); fs.chmodSync(path.join(dir, 'curl'), 0o755); }
  return dir;
}

/** A `curl` that writes `releases` to its -o file and reports HTTP 200, and fails any download. */
const releasesCurl = (releases: unknown, file: string): string => {
  fs.writeFileSync(file, JSON.stringify(releases));
  return `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) shift 2 ;; *) shift ;; esac; done\n`
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
beforeAll(() => {
  artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-artifacts-'));
  if (!HAS_CC) return;
  const source = path.join(artifacts, 'stand-in.c');
  fs.writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("2.0.0-beta.1"); return 0; }\n');
  const binary = path.join(artifacts, `myco-${TARGET}`);
  expect(spawnSync('cc', ['-o', binary, source]).status).toBe(0);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  fs.writeFileSync(path.join(artifacts, 'SHA256SUMS'), `${sha}  myco-${TARGET}\n`);
});

const freshHome = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-home-')));

describe('the Myco 2.0 installer', () => {
  it.skipIf(!HAS_CC)('installs the binary for a first-time user, starts nothing, and points at `myco login`', () => {
    const home = freshHome();
    const run = install(home, { MYCO_INSTALL_FROM: artifacts, MYCO_INSTALL_VERSION: '2.0.0-beta.1' });
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
    expect(install(home, { MYCO_INSTALL_FROM: artifacts, MYCO_INSTALL_VERSION: '2.0.0-beta.1' }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf8')).toBe(zshenv);
  });

  it.skipIf(!HAS_CC)('tells a Myco 1.4 machine so, points at `myco cutover --dry-run`, and moves nothing of 1.4', () => {
    const home = freshHome();
    const vault = path.join(home, '.myco', 'groves', 'grove_a', 'myco.db');
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.writeFileSync(vault, 'a 1.4 vault');
    const oldBinary = path.join(home, '.myco', 'bin', 'myco');
    fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
    fs.writeFileSync(oldBinary, '#!/bin/sh\necho 1.4.8\n');
    fs.chmodSync(oldBinary, 0o755);
    const run = install(home, { MYCO_INSTALL_FROM: artifacts, MYCO_INSTALL_VERSION: '2.0.0-beta.1' });
    expect(run.status).toBe(0);
    expect(run.out).toContain(`Myco 1.4 is on this machine (its vaults in ${path.join(home, '.myco', 'groves')})`);
    expect(run.out).toContain('2.0 replaced its binary, so its hooks capture nothing until you move over.');
    expect(run.out).toContain('myco cutover --dry-run');
    expect(run.out).toContain('myco login <invite link>');
    expect(fs.readFileSync(vault, 'utf8')).toBe('a 1.4 vault');
    expect(files(path.join(home, '.myco')).filter((f) => !f.startsWith('bin/') && f !== 'install.json')).toEqual(['groves/grove_a/myco.db']);
  });

  it('changes nothing on a dry run', () => {
    const home = freshHome();
    const run = install(home, { MYCO_INSTALL_FROM: artifacts, MYCO_INSTALL_VERSION: '2.0.0-beta.1' }, ['--dry-run']);
    expect(run.status).toBe(0);
    expect(run.out).toContain('Dry run: nothing was downloaded or changed.');
    expect(files(home)).toEqual([]);
  });

  it('refuses the Myco 1.4 Team Host option and points at self-hosting', () => {
    const run = install(freshHome(), {}, ['--serve']);
    expect(run.status).toBe(1);
    expect(run.out).toContain('docs/self-hosting.md');
  });

  describe('chooses only Myco 2.x from the GitHub releases', () => {
    const release = (tag: string, prerelease = false) => ({ tag_name: tag, prerelease, draft: false });
    const beforeGa = [release('myco/v1.4.8'), release('myco/v1.4.9-beta.1', true), release('myco/v2.0.0-beta.1', true), release('myco-shared/v2.0.0')];
    const afterGa = [...beforeGa, release('myco/v2.0.0'), release('myco/v2.1.0-beta.1', true)];
    for (const jq of [true, false]) {
      it(`${jq ? 'with' : 'without'} jq`, () => {
        const pick = (releases: unknown[], channel: string): Run => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-install-tools-'));
          const tools = toolbox(path.join(dir, 'bin'), { jq, curl: releasesCurl(releases, path.join(dir, 'releases.json')) });
          return install(freshHome(), { MYCO_CHANNEL: channel }, ['--dry-run'], tools);
        };
        const stableBeforeGa = pick(beforeGa, 'stable');
        expect(stableBeforeGa.status).toBe(0);
        expect(stableBeforeGa.out).toContain('No Myco 2 release yet; installing the newest prerelease, myco/v2.0.0-beta.1.');
        expect(stableBeforeGa.out).toContain(`Would install myco-${TARGET} (2.0.0-beta.1) from https://github.com/goondocks-co/myco/releases/download/myco%2Fv2.0.0-beta.1`);
        expect(pick(beforeGa, 'beta').out).toContain('Found: myco/v2.0.0-beta.1');
        expect(pick(afterGa, 'stable').out).toContain('Found: myco/v2.0.0');
        expect(pick(afterGa, 'stable').out).not.toContain('prerelease');
        expect(pick(afterGa, 'beta').out).toContain('Found: myco/v2.1.0-beta.1');
        const onlyOld = pick([release('myco/v1.4.8'), release('myco/v1.5.0-beta.1', true)], 'beta');
        expect(onlyOld.status).toBe(1);
        expect(onlyOld.out).toContain('No Myco 2.x release found.');
      });
    }
  });

  it.skipIf(spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).status !== 0)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

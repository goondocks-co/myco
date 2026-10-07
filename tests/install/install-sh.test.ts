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
 * already joined to a Deployment it refreshes the agents' Myco setup with the
 * build it installed, and says how to do it by hand if that fails; on a machine
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
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
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
  const tools = ['sh', 'uname', 'mktemp', 'sed', 'grep', 'awk', 'sort', 'head', 'tail', 'cut', 'tr', 'cat', 'rm', 'mkdir', 'mv', 'cp', 'chmod', 'sleep', 'kill', 'date',
    'sha256sum', 'shasum', 'codesign', 'xattr', 'perl', ...(opts.jq ? ['jq'] : []), ...(opts.curl ? [] : ['curl'])];
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(dir, tool));
  }
  if (opts.curl) { fs.writeFileSync(path.join(dir, 'curl'), opts.curl); fs.chmodSync(path.join(dir, 'curl'), 0o755); }
  return dir;
}

/**
 * A `curl` that answers the releases list with `releases` (HTTP 200). A download is served from `serve` when given,
 * by the file name the URL ends in; otherwise it gets the releases list too. `log` records each call's arguments.
 */
const releasesCurl = (releases: unknown, file: string, opts: { pretty?: boolean; log?: string; serve?: string; pages?: unknown[][]; current?: string } = {}): string => {
  fs.writeFileSync(file, opts.pretty ? JSON.stringify(releases, null, 2) : JSON.stringify(releases));
  for (const [i, page] of (opts.pages ?? []).entries()) fs.writeFileSync(`${file}.${i + 1}`, JSON.stringify(page));
  return `#!/bin/sh\n${opts.log ? `echo "$*" >> '${opts.log}'\n` : ''}out=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|-H) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\n`
    + `[ -n "$out" ] || exit 22\n`
    + (opts.serve ? `case "$url" in */releases/download/*) cp "${opts.serve}/\${url##*/}" "$out" || exit 22; exit 0 ;; esac\n` : '')
    + (opts.pages ? `page=1; case "$url" in *'&page='*) page="\${url##*page=}" ;; esac\ncp '${file}.'"$page" "$out"\nprintf 200\n` : `cp '${file}' "$out"\nprintf 200\n`);
};

/** Every temporary directory a test makes, removed when the file's tests end. */
const made: string[] = [];
const tmp = (prefix: string): string => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

interface Run { status: number | null; out: string; home: string }

function install(home: string, env: Record<string, string>, args: string[] = [], toolPath?: string): Run {
  const result = spawnSync('sh', [SCRIPT, ...args], {
    cwd: home,
    env: { PATH: toolPath ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, ...env }, encoding: 'utf8', timeout: 90_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''), home };
}

/** Every file under `dir`, relative to it. */
const files = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : []);

let artifacts: string;
/**
 * Install sources: a good build, one whose bytes no longer match SHA256SUMS, one SHA256SUMS does not list, one that
 * does not run, and two builds that record every other command they are given in `$MYCO_HOME/commands.log`, one
 * answering it and one failing it.
 */
const sources = { tampered: '', unlisted: '', broken: '', recording: '', refusing: '', slow: '', stalling: '' };
beforeAll(() => {
  artifacts = tmp('myco-install-artifacts-');
  if (!HAS_CC) return;
  const build = (dir: string, body: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'stand-in.c');
    fs.writeFileSync(source, `#include <stdio.h>\nint main(void) { ${body} }\n`);
    const binary = path.join(dir, `myco-${TARGET}`);
    const compiled = spawnSync('cc', ['-o', binary, source], { encoding: 'utf8' });
    expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
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
  const recorder = (dir: string, exit: number): string => {
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'recorder.c');
    fs.writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("2.0.0-beta.2"); return 0; }
  const char *home = getenv("MYCO_HOME");
  char file[4096];
  snprintf(file, sizeof file, "%s/commands.log", home ? home : "/nonexistent");
  FILE *log = fopen(file, "a");
  if (log) { for (int i = 1; i < argc; i++) fprintf(log, "%s%s", i > 1 ? " " : "", argv[i]); fputc('\\n', log); fclose(log); }
  if (${exit} != 0) { fputs("the Deployment could not be reached\\n", stderr); return ${exit}; }
  puts("Refreshed Claude Code.");
  return 0;
}
`);
    const binary = path.join(dir, `myco-${TARGET}`);
    expect(spawnSync('cc', ['-o', binary, source]).status).toBe(0);
    fs.rmSync(source);
    return binary;
  };
  sources.recording = path.join(artifacts, 'recording');
  sums(recorder(sources.recording, 0));
  sources.refusing = path.join(artifacts, 'refusing');
  sums(recorder(sources.refusing, 3));
  const compiled = (dir: string, program: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'program.c');
    fs.writeFileSync(source, program);
    const binary = path.join(dir, `myco-${TARGET}`);
    expect(spawnSync('cc', ['-o', binary, source]).status).toBe(0);
    fs.rmSync(source);
    return binary;
  };
  // A build whose run check takes a while, so an install can be interrupted part way through.
  sources.slow = path.join(artifacts, 'slow');
  sums(compiled(sources.slow, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { sleep(6); puts("2.0.0-beta.1"); return 0; }\n'));
  // A build whose agent refresh never finishes, and ignores TERM, so only the watchdog's KILL stops it.
  sources.stalling = path.join(artifacts, 'stalling');
  sums(compiled(sources.stalling, `#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("2.0.0-beta.2"); return 0; }
  signal(SIGTERM, SIG_IGN);
  sleep(60);
  return 0;
}
`));
});

const freshHome = () => fs.realpathSync.native(tmp('myco-install-home-'));
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

  it.skipIf(!HAS_CC)('records an absolute destination for a relative MYCO_BIN_DIR', () => {
    const home = freshHome();
    expect(install(home, { ...FROM(), MYCO_BIN_DIR: './tools' }).status).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(home, '.myco/install.json'), 'utf8'));
    expect(path.isAbsolute(marker.bin)).toBe(true);
    expect(fs.realpathSync(marker.bin)).toBe(path.join(home, 'tools/myco'));
  });

  describe('on a machine already joined to a Deployment', () => {
    /** A home holding a Deployment membership, as `myco login` leaves one. */
    const memberHome = (): string => {
      const home = freshHome();
      fs.mkdirSync(path.join(home, '.myco', 'member', 'deployments'), { recursive: true });
      fs.writeFileSync(path.join(home, '.myco', 'member', 'deployments', 'dep_1.json'), '{}');
      return home;
    };
    const from = (dir: string) => ({ MYCO_INSTALL_FROM: dir, MYCO_INSTALL_VERSION: '2.0.0-beta.2' });

    it.skipIf(!HAS_CC)('refreshes the agents\' Myco setup with the build it installed, in that home, and asks for no login', () => {
      const home = memberHome();
      const run = install(home, from(sources.recording));
      expect(run.status).toBe(0);
      expect(fs.readFileSync(path.join(home, '.myco', 'commands.log'), 'utf8')).toBe('member provision --refresh\n');
      expect(run.out).toContain('Refreshed Claude Code.');
      expect(run.out).toContain('Your agents now use Myco 2.0.0-beta.2.');
      expect(run.out).not.toContain('myco login <invite link>');
    });

    it.skipIf(!HAS_CC)('keeps the install and says how to refresh by hand when the refresh fails', () => {
      const home = memberHome();
      const run = install(home, from(sources.refusing));
      expect(run.status).toBe(0);
      expect(spawnSync(path.join(home, '.myco', 'bin', 'myco'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.2');
      expect(run.out).toContain('the Deployment could not be reached');
      expect(run.out).toContain("Your agents' Myco setup was not refreshed. Run: myco member provision --refresh");
    });

    it.skipIf(!HAS_CC)('stops a refresh that never finishes, TERM then KILL, says it timed out, and keeps the install', () => {
      const home = memberHome();
      const started = Date.now();
      const run = install(home, { ...from(sources.stalling), MYCO_REFRESH_TIMEOUT: '1' });
      expect(run.status).toBe(0);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(run.out).toContain("Your agents' Myco setup was not refreshed: the refresh timed out after 1 s. Run: myco member provision --refresh");
      expect(run.out).not.toMatch(/Killed|Terminated/);
      expect(spawnSync(path.join(home, '.myco', 'bin', 'myco'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.2');
    });

    it.skipIf(!HAS_CC)('says the agents run a pinned binary when a machine pin names another one, and this install when it names this one', () => {
      const pinned = memberHome();
      fs.writeFileSync(path.join(pinned, '.myco', 'runtime.command'), '/opt/dogfood/myco\n');
      const other = install(pinned, from(sources.recording));
      expect(other.out).toContain(`Your agents run the binary pinned in ${path.join(pinned, '.myco', 'runtime.command')} (/opt/dogfood/myco), not this install.`);
      expect(other.out).not.toContain('Your agents now use');
      const same = memberHome();
      fs.writeFileSync(path.join(same, '.myco', 'runtime.command'), `${path.join(same, '.myco', 'bin', 'myco')}\n`);
      expect(install(same, from(sources.recording)).out).toContain('Your agents now use Myco 2.0.0-beta.2.');
    });

    it.skipIf(!HAS_CC)('runs nothing but --version for a first-time machine', () => {
      const home = freshHome();
      const run = install(home, from(sources.recording));
      expect(run.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.myco', 'commands.log'))).toBe(false);
      expect(run.out).toContain('myco login <invite link>');
    });
  });

  it.skipIf(!HAS_CC)('replaces the binary by a rename, never by writing over the file a running myco may be executing', () => {
    const home = freshHome();
    expect(install(home, FROM()).status).toBe(0);
    const before = fs.statSync(path.join(home, '.myco', 'bin', 'myco')).ino;
    expect(install(home, { MYCO_INSTALL_FROM: sources.recording, MYCO_INSTALL_VERSION: '2.0.0-beta.2' }).status).toBe(0);
    expect(spawnSync(path.join(home, '.myco', 'bin', 'myco'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.2');
    expect(fs.statSync(path.join(home, '.myco', 'bin', 'myco')).ino).not.toBe(before);
  });

  it.skipIf(!HAS_CC)('removes what it staged and installs nothing when it is interrupted', async () => {
    const home = freshHome();
    const bin = path.join(home, '.myco', 'bin');
    const child = spawn('sh', [SCRIPT], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, MYCO_INSTALL_FROM: sources.slow, MYCO_INSTALL_VERSION: '2.0.0-beta.1' }, stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // Interrupted while it checks the staged build runs.
    const staged = () => fs.existsSync(bin) && fs.readdirSync(bin).some((name) => name.startsWith('.myco-install-'));
    for (let i = 0; i < 100 && !staged(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(staged()).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(130);
    expect(fs.readdirSync(bin)).toEqual([]);
  });

  it.skipIf(!HAS_CC)('puts its bin directory on PATH in a .bash_profile that exists', () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, '.bash_profile'), '# mine\n');
    expect(install(home, FROM()).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toContain(`export PATH="${path.join(home, '.myco', 'bin')}:$PATH"`);
  });

  describe('on a machine with Myco 1.4', () => {
    it('keeps the preview channel in its explicit replacement command', () => {
      const legacy = legacyHome({ binary: true });
      const run = install(legacy.home, { ...FROM(), MYCO_CHANNEL: 'alpha' });
      expect(run.status).toBe(1);
      expect(run.out).toContain('| MYCO_CHANNEL=alpha sh -s -- --replace-1.4');
    });

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
        expect(run.out).toContain('docs/upgrade.md#upgrading-from-myco-14');
        expect(files(legacy.home)).toEqual(before);
        if (binary) expect(fs.readFileSync(legacy.binary, 'utf8')).toBe('#!/bin/sh\necho 1.4.8\n');
      }
    });

    it.skipIf(!HAS_CC)('takes 1.4\'s place when asked, by flag or by env, marks the slot so a running 1.4 does not adopt it, and moves nothing of 1.4', () => {
      for (const [env, args] of [[{}, ['--replace-1.4']], [{ MYCO_REPLACE_LEGACY: '1' }, []]] as const) {
        const legacy = legacyHome({ binary: true });
        const run = install(legacy.home, { ...FROM(), ...env }, [...args]);
        expect(run.status).toBe(0);
        expect(spawnSync(legacy.binary, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0-beta.1');
        expect(run.out).toContain('2.0 took its place, so 1.4 captures nothing until you move over.');
        expect(run.out).toContain('myco cutover --dry-run');
        expect(fs.readFileSync(legacy.vault, 'utf8')).toBe('a 1.4 vault');
        expect(files(path.join(legacy.home, '.myco')).filter((f) => !f.startsWith('bin/') && f !== 'install.json')).toEqual(['groves/grove_a/myco.db']);
        // 1.4.8's idle adopt skips a versions/<v> slot holding this marker.
        expect(files(path.join(legacy.home, '.myco', 'bin'))).toEqual(['myco', 'versions/2.0.0-beta.1/.adopt-failed', 'versions/2.0.0-beta.1/myco']);
      }
    });

    it.skipIf(!HAS_CC)('installs as usual in a home a cutover already moved to 2.0', () => {
      const legacy = legacyHome({ binary: false });
      fs.mkdirSync(path.join(legacy.home, '.myco', 'member'), { recursive: true });
      fs.writeFileSync(path.join(legacy.home, '.myco', 'member', 'cutover.json'), '{}');
      const run = install(legacy.home, FROM());
      expect(run.status).toBe(0);
      expect(run.out).toContain('Myco 2.0.0-beta.1 installed to');
      expect(files(path.join(legacy.home, '.myco', 'bin'))).toEqual(['myco', 'versions/2.0.0-beta.1/myco']);
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
    const cut = path.join(tmp('myco-install-cut-'), 'install.sh');
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
    /** A release as GitHub lists it, with this machine's binary and SHA256SUMS attached unless `assets` says otherwise. */
    const release = (tag: string, prerelease = false, draft = false, assets = [`myco-${TARGET}`, 'SHA256SUMS']) => ({
      tag_name: tag, name: tag, prerelease, draft, assets: assets.map((name) => ({ name, uploader: { login: 'github-actions' } })),
    });
    const beforeGa = [release('myco/v1.4.8'), release('myco/v1.4.9-beta.1', true), release('myco/v2.0.0-beta.1', true), release('myco-shared/v2.0.0')];
    const afterGa = [...beforeGa, release('myco/v2.0.0'), release('myco/v2.1.0-beta.1', true)];
    for (const jq of [true, false]) {
      describe(jq ? 'with jq' : 'without jq', () => {
        const pick = (releases: unknown[], channel: string, opts: { pretty?: boolean; log?: string; args?: string[]; serve?: string; pages?: unknown[][]; current?: string } = {}): Run => {
          const dir = tmp('myco-install-tools-');
          const tools = toolbox(path.join(dir, 'bin'), { jq, curl: releasesCurl(releases, path.join(dir, 'releases.json'), opts) });
          const home = freshHome();
          if (opts.current) {
            const bin = path.join(home, '.myco', 'bin'); fs.mkdirSync(bin, { recursive: true });
            fs.writeFileSync(path.join(bin, 'myco'), `#!/bin/sh\necho ${opts.current}\n`, { mode: 0o755 });
          }
          return install(home, { MYCO_CHANNEL: channel }, opts.args ?? ['--dry-run'], tools);
        };
        it('finds stable 1.4 beyond the first page of 2.0 prereleases', () => {
          const pages = [Array.from({ length: 100 }, (_, i) => release(`myco/v2.0.0-alpha.${i + 1}`, true)), [release('myco/v1.4.8')]];
          expect(pick([], 'stable', { pages }).out).toContain('Found: myco/v1.4.8');
        });
        it('removing alpha tags leaves an installed alpha binary and its channel intact', () => {
          const run = pick([release('myco/v2.0.0'), release('myco/v2.1.0-alpha.2', true)], 'alpha', { current: '2.1.0-alpha.10', args: [] });
          expect(run.status).toBe(0);
          expect(run.out).toContain('staying put');
          expect(files(run.home)).toEqual(['.myco/bin/myco']);
          expect(fs.readFileSync(path.join(run.home, '.myco/bin/myco'), 'utf8')).toBe('#!/bin/sh\necho 2.1.0-alpha.10\n');
        });
        it('stable stays on 1.4 until GA and beta opts into prereleases', () => {
          const stableBeforeGa = pick(beforeGa, 'stable');
          expect(stableBeforeGa.status).toBe(0);
          expect(stableBeforeGa.out).not.toContain('installing the newest prerelease');
          expect(stableBeforeGa.out).toContain(`Would install myco-${TARGET} (1.4.8) from https://github.com/goondocks-co/myco/releases/download/myco%2Fv1.4.8`);
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
          expect(found([['myco/v2.0.0-rc.1', true], ['myco/v2.0.0-beta.9', true]])).toBe('myco/v2.0.0-beta.9');
          expect(found([['myco/v2.10.0', false], ['myco/v2.9.0', false]])).toBe('myco/v2.10.0');
        });
        it('never a release still being published: its binary or SHA256SUMS not yet attached', () => {
          for (const assets of [['SHA256SUMS'], [`myco-${TARGET}`], []]) {
            expect(pick([...afterGa, release('myco/v2.2.0', false, false, assets)], 'stable').out).toContain('Found: myco/v2.0.0');
          }
          // Another platform's binary is not this machine's.
          const other = TARGET.startsWith('darwin') ? 'myco-linux-x64' : 'myco-darwin-arm64';
          expect(pick([...afterGa, release('myco/v2.2.0', false, false, [other, 'SHA256SUMS'])], 'stable').out).toContain('Found: myco/v2.0.0');
        });
        it('treats a release GitHub marks as a prerelease as one, even with no hyphen in its tag', () => {
          expect(pick([...afterGa, release('myco/v2.2.0', true)], 'stable').out).toContain('Found: myco/v2.0.0');
          expect(pick([...afterGa, release('myco/v2.2.0', true)], 'beta').out).toContain('Found: myco/v2.1.0-beta.1');
        });
        it.skipIf(!HAS_CC)('records a prerelease as one in install.json, whether its tag or GitHub says so', () => {
          const marker = (run: Run) => JSON.parse(fs.readFileSync(path.join(run.home, '.myco', 'install.json'), 'utf8')) as { channel: string; prerelease: boolean };
          const fallback = pick(beforeGa, 'beta', { args: [], serve: artifacts });
          expect(fallback.status).toBe(0);
          expect(fallback.out).not.toContain('This machine stays on the stable channel');
          expect(marker(fallback)).toMatchObject({ channel: 'beta', prerelease: true });
          expect(marker(pick(afterGa, 'stable', { args: [], serve: artifacts }))).toMatchObject({ channel: 'stable', prerelease: false });
          expect(marker(pick([...afterGa, release('myco/v2.2.0', true)], 'beta', { args: [], serve: artifacts }))).toMatchObject({ channel: 'beta', prerelease: true });
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
          const log = path.join(tmp('myco-install-curl-'), 'calls');
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

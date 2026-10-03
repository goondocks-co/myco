/**
 * The unit that runs the Deployment when its owner logs in.
 *
 * Rendered rather than installed: the three platforms cannot be exercised on
 * one machine, and what a unit says is what decides whether a Deployment comes
 * back after a reboot. Each assertion below is a way a service fails quietly
 * when the unit omits it.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVER_UNIT,
  ServicePathUnsupported,
  ServicePlatformUnsupported,
  assertInstalledBinary,
  assertUnquotablePath,
  defaultSpec,
  platformDetachedSpawner,
  reloadServiceDetached,
  renderUnit,
  servicePaths,
} from '@myco/server/service.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOME = '/Users/dev';
const BINARY = '/Users/dev/.myco/bin/myco';
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

const rendered = (platform: typeof PLATFORMS[number]): string => {
  const spec = defaultSpec(BINARY, HOME);
  return renderUnit(spec, servicePaths(spec, platform), platform);
};

describe('the per-user service unit', () => {
  for (const platform of PLATFORMS) {
    it(`runs the binary's own \`server run\` on ${platform}`, () => {
      const unit = rendered(platform);
      expect(unit).toContain(BINARY);
      expect(unit).toContain('server');
      expect(unit).toContain('run');
      expect(unit).toMatch(platform === 'darwin'
        ? /<string>--target<\/string>\s*<string>local<\/string>/
        : /server run --target local/);
    });

    it(`sends both streams somewhere readable on ${platform}`, () => {
      const spec = defaultSpec(BINARY, HOME);
      const paths = servicePaths(spec, platform);
      expect(paths.outLog).toBe(join(HOME, '.myco', 'logs', 'server.log'));
      expect(paths.errLog).toBe(join(HOME, '.myco', 'logs', 'server.error.log'));
      // Every platform names both files in the unit. Task Scheduler redirects
      // nothing of its own, so its action carries the append operators.
      expect(rendered(platform)).toContain(paths.outLog);
      expect(rendered(platform)).toContain(paths.errLog);
    });

    it(`comes back when it exits on ${platform}`, () => {
      const unit = rendered(platform);
      const restarts = platform === 'darwin' ? 'KeepAlive' : platform === 'linux' ? 'Restart=on-failure' : 'RestartOnFailure';
      expect(unit).toContain(restarts);
    });
  }

  it('waits for the network on the platform whose units order against it', () => {
    // A Deployment that starts before the network is up fails its first work
    // and stays down until someone notices.
    expect(rendered('linux')).toContain('After=network-online.target');
    expect(rendered('darwin')).toContain('NetworkState');
  });

  it('declares a PATH on every platform, so a run can find the harnesses a login shell would', () => {
    for (const platform of PLATFORMS) {
      const spec = defaultSpec(BINARY, HOME, platform);
      expect({ platform, hasLocalBin: spec.pathEnv.includes(join(HOME, '.local', 'bin')) })
        .toEqual({ platform, hasLocalBin: true });
      expect(renderUnit(spec, servicePaths(spec, platform), platform)).toContain(spec.pathEnv);
    }
    expect(rendered('linux')).toContain(`Environment=PATH=${defaultSpec(BINARY, HOME).pathEnv}`);
  });

  it('names the same service on every platform it records one under', () => {
    expect(rendered('darwin')).toContain(SERVER_UNIT.label);
    expect(servicePaths(defaultSpec(BINARY, HOME), 'darwin').unitFile)
      .toBe(join(HOME, 'Library', 'LaunchAgents', `${SERVER_UNIT.label}.plist`));
    expect(servicePaths(defaultSpec(BINARY, HOME), 'linux').unitFile)
      .toBe(join(HOME, '.config', 'systemd', 'user', 'myco-server.service'));
  });
});

describe('the binary path a unit can name', () => {
  it('refuses whitespace rather than quoting it', () => {
    expect(() => assertUnquotablePath('/Users/dev/My Apps/myco')).toThrow(ServicePathUnsupported);
    expect(() => assertUnquotablePath('/Users/dev/My Apps/myco')).toThrow(/whitespace/);
  });

  it('refuses a relative path, which resolves against whatever the platform starts it in', () => {
    expect(() => assertUnquotablePath('./myco')).toThrow(ServicePathUnsupported);
  });

  it('refuses to render a unit for a path it cannot name', () => {
    const spec = defaultSpec('/Users/dev/My Apps/myco', HOME);
    for (const platform of PLATFORMS) {
      expect(() => renderUnit(spec, servicePaths(spec, platform), platform)).toThrow(ServicePathUnsupported);
    }
  });

  it('refuses to run anything but the installed binary', () => {
    // A source checkout runs the CLI through a runtime, and a unit written from
    // that names a program answering `server run` with a usage error.
    expect(() => assertInstalledBinary('/opt/homebrew/bin/bun')).toThrow(ServicePathUnsupported);
    expect(() => assertInstalledBinary('/usr/local/bin/node')).toThrow(/installed myco binary/);
    expect(() => assertInstalledBinary(BINARY)).not.toThrow();
    // The Windows binary name is accepted wherever the path is absolute for the
    // platform doing the install; the path always comes from this process.
    expect(() => assertInstalledBinary('/Myco/bin/myco.exe')).not.toThrow();
  });

  it('refuses a platform it defines no service for, rather than writing a unit nothing reads', () => {
    const spec = defaultSpec(BINARY, HOME);
    expect(() => servicePaths(spec, 'freebsd' as NodeJS.Platform)).toThrow(ServicePlatformUnsupported);
  });
});

/**
 * The absence the issue asks to be asserted, not assumed.
 *
 * A Deployment this machine runs is reached without a container runtime and
 * without a Node runtime. Both are easy to reintroduce by accident — a verb
 * that shells out to one, a unit that runs the binary through one — and neither
 * failure shows up until someone installs on a machine that has neither.
 */
/**
 * A source reduced to what the process actually executes: help templates and
 * comments blanked, line positions kept so a hit still names its line.
 *
 * Help text is what a reader is shown and comments are what a reader is told;
 * neither is a command, and both legitimately name the tools this asserts are
 * never run.
 */
function executableText(source: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return source
    .replace(/export const [A-Z_]*HELP[A-Z_]* = `[\s\S]*?`;/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

describe('what a Deployment on this machine never reaches for', () => {
  /**
   * Every source the laptop path reaches, walked from its own entry points
   * rather than listed by hand: a hand-list goes stale the moment a verb gains
   * a helper.
   *
   * `cli/server.ts` is scanned too, since that is where the verbs live, but it
   * is not walked — it also dispatches the Compose and Cloudflare targets,
   * which legitimately run a container runtime and `wrangler`.
   */
  const SOURCES = ((): string[] => {
    const root = join(REPO_ROOT, 'packages', 'myco', 'src');
    const seen = new Set<string>();
    const walk = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      for (const m of readFileSync(join(root, rel), 'utf8').matchAll(/from '(\.[^']+)\.js'/g)) {
        const next = join(rel, '..', `${m[1]!}.ts`).replace(/\\/g, '/');
        if (existsSync(join(root, next))) walk(next);
      }
    };
    for (const entry of ['server/local.ts', 'server/local-run.ts', 'server/service.ts']) walk(entry);
    // Generated asset modules are base64 payloads, not code; scanning them
    // matches any substring by chance and executes nothing.
    return ['cli/server.ts', ...seen].filter((rel) => !rel.endsWith('.generated.ts'));
  })();

  it('names neither a container runtime nor a Node runtime as a command it runs', () => {
    const offenders: string[] = [];
    for (const rel of SOURCES) {
      // `myco server` serves three targets from one file, and the Compose
      // target's help legitimately names `docker compose`. Help text is what a
      // reader is shown, never what the process runs, so it is not scanned.
      const source = executableText(readFileSync(join(REPO_ROOT, 'packages', 'myco', 'src', rel), 'utf8'));
      source.split('\n').forEach((code, i) => {
        // A quoted argv head or shelled command. `node:fs` and `bun:sqlite` are
        // builtin module specifiers of the runtime already running, so the
        // colon form is not a command and is not matched.
        if (/['"`](docker|node|npm|npx|bun)(?![:\w-])/.test(code)) offenders.push(`${rel}:${i + 1}  ${code.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('runs the binary directly in every unit, never through an interpreter', () => {
    for (const platform of PLATFORMS) {
      const unit = rendered(platform);
      expect({ platform, viaInterpreter: /\b(node|npx|npm|bun)\b/.test(unit) }).toEqual({ platform, viaInterpreter: false });
      expect({ platform, viaContainer: /\bdocker\b/.test(unit) }).toEqual({ platform, viaContainer: false });
    }
  });
});

describe('a unit loaded again from a process of its own', () => {
  const withUnit = (home: string): ReturnType<typeof defaultSpec> => {
    const spec = defaultSpec(BINARY, home);
    const { unitFile } = servicePaths(spec, 'darwin');
    mkdirSync(dirname(unitFile), { recursive: true });
    writeFileSync(unitFile, '<plist/>');
    return spec;
  };

  /**
   * Run the reload helper through a real `/bin/sh` against a fake `launchctl`.
   * The unit starts loaded as process 100. `unload` leaves it listed, still as
   * process 100, for `lingers` more `list` calls — the teardown the legacy verb
   * does not wait for. `load` registers it as process 200 only from attempt
   * `loadsFrom` on; `list` answers only for a registered unit, whatever `load`
   * exits with. `sleep` is a no-op, so waiting costs nothing.
   */
  function reloadAgainst(home: string, { loadsFrom = 1, lingers = 0, replacing = 100 as number | undefined } = {}): { status: boolean; calls: string; log: string; spawned: string[][] } {
    const spec = withUnit(home);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const record = join(home, 'launchctl.calls');
    const listed = join(home, 'listed');
    const linger = join(home, 'linger');
    const attempts = join(home, 'loads');
    writeFileSync(listed, '100');
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'launchctl'), [
      '#!/bin/sh',
      `printf '%s|' "$@" >> '${record}'; echo >> '${record}'`,
      'case "$1" in',
      `  unload) echo ${lingers} > '${linger}' ;;`,
      `  load) n=$(( $(cat '${attempts}' 2>/dev/null || echo 0) + 1 )); echo $n > '${attempts}'`,
      `        if [ $n -ge ${loadsFrom} ]; then rm -f '${linger}'; echo 200 > '${listed}'; else echo 'Load failed: 5: Input/output error'; fi ;;`,
      '  list)',
      `        if [ -f '${linger}' ]; then left=$(cat '${linger}'); if [ "$left" -le 0 ]; then rm -f '${listed}' '${linger}'; else echo $((left - 1)) > '${linger}'; fi; fi`,
      `        [ -f '${listed}' ] || exit 113`,
      `        printf '{\\n\\t"PID" = %s;\\n\\t"Label" = "x";\\n};\\n' "$(cat '${listed}')" ;;`,
      'esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    const spawned: string[][] = [];
    let log = '';
    const status = reloadServiceDetached(spec, {
      platform: 'darwin',
      ...(replacing === undefined ? {} : { replacing }),
      spawnDetached: (command, args, logFile) => {
        spawned.push([command, args[0]!, logFile, ...args.slice(3)]);
        const run = spawnSync(command, [...args], { env: { PATH: `${bin}:/bin:/usr/bin` }, encoding: 'utf8' });
        log = `${run.stdout}${run.stderr}`;
        return run.status === 0;
      },
    });
    return { status, calls: existsSync(record) ? readFileSync(record, 'utf8') : '', log, spawned };
  }

  const loads = (calls: string): number => calls.split('\n').filter((line) => line.startsWith('load|')).length;

  it('unloads the unit and loads it again, in a detached shell whose output goes to the unit\'s error log', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco reload '));
    try {
      const { unitFile, errLog } = servicePaths(defaultSpec(BINARY, home), 'darwin');
      const result = reloadAgainst(home);
      expect(result.status).toBe(true);
      expect(result.spawned).toEqual([['/bin/sh', '-c', errLog, SERVER_UNIT.label, unitFile, '100']]);
      expect(result.calls).toBe(`unload|${unitFile}|\nlist|${SERVER_UNIT.label}|\nload|-w|${unitFile}|\nlist|${SERVER_UNIT.label}|\nlist|${SERVER_UNIT.label}|\n`);
      expect(result.log).toMatch(/myco reload of co\.goondocks\.myco-server: unloading\n.*: loaded again as process 200\n$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('waits for launchd to let go of the unit it unloaded before loading it, so the job being torn down is never taken for the new one', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const result = reloadAgainst(home, { lingers: 3 });
      expect(result.status).toBe(true);
      const calls = result.calls.split('\n');
      // Four lists after the unload (three still naming process 100), then the load.
      expect(calls.slice(1, 5).every((line) => line.startsWith('list|'))).toBe(true);
      expect(calls[5]!.startsWith('load|')).toBe(true);
      expect(result.log).toContain('loaded again as process 200');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not take the process it replaces for the reloaded unit, even when the teardown outlasts its wait', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      // Listed as process 100 through the whole teardown wait and every load, then gone.
      const result = reloadAgainst(home, { lingers: 1000, loadsFrom: Number.MAX_SAFE_INTEGER });
      expect(result.status).toBe(false);
      expect(result.log).toContain('still listed 20 s after unload; loading anyway');
      expect(result.log).not.toMatch(/: loaded again/);
      expect(result.log).toMatch(/could not be loaded again/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('loads again until launchd holds the unit, whatever the first load answered', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const result = reloadAgainst(home, { loadsFrom: 2 });
      expect(result.status).toBe(true);
      expect(loads(result.calls)).toBe(2);
      expect(result.log).toContain('Load failed: 5: Input/output error');
      expect(result.log).toContain('not loaded yet; trying again in 1 s');
      expect(result.log).toContain('loaded again as process 200');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('gives up after its window and says so in the log, rather than trying forever', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const result = reloadAgainst(home, { loadsFrom: Number.MAX_SAFE_INTEGER });
      expect(result.status).toBe(false);
      // Pauses of 1, 2, 4, 8, 8, 8 s reach the 30 s window on the seventh load.
      expect(loads(result.calls)).toBe(7);
      expect(result.log).toMatch(/could not be loaded again; it runs again after myco worker install or the next login\n$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so when it is stopped after the unload', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const spec = withUnit(home);
      const bin = join(home, 'bin');
      mkdirSync(bin);
      // The unload stops the helper itself, the way a caller's TERM would.
      writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\n[ "$1" = unload ] && kill -TERM $PPID\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      let log = '';
      let status = null as number | null;
      reloadServiceDetached(spec, {
        platform: 'darwin',
        spawnDetached: (command, args) => {
          const run = spawnSync(command, [...args], { env: { PATH: `${bin}:/bin:/usr/bin` }, encoding: 'utf8' });
          log = `${run.stdout}${run.stderr}`;
          status = run.status;
          return true;
        },
      });
      expect(status).toBe(1);
      expect(log).toMatch(/: unloading\n.*: stopped after unload; run myco worker install\n$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('starts the helper in a session of its own, so the unload of the unit it serves does not stop it', async () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const log = join(home, 'logs', 'helper.log');
      expect(platformDetachedSpawner('/bin/sh', ['-c', 'echo "$$ $(ps -o pgid= -p $$)"'], log)).toBe(true);
      let text = '';
      for (let i = 0; i < 100 && !/\d+ +\d+/.test(text); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      }
      const [pid, pgid] = text.trim().split(/\s+/).map(Number);
      // A session leader leads its own process group; the test runner's group is another.
      expect(pgid).toBe(pid!);
      expect(pgid).not.toBe(Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim()));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does nothing without a unit, or on a platform whose service stops its whole group', () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-reload-'));
    try {
      const never = (): boolean => { throw new Error('nothing should be started'); };
      expect(reloadServiceDetached(defaultSpec(BINARY, home), { platform: 'darwin', spawnDetached: never })).toBe(false);
      const spec = withUnit(home);
      expect(reloadServiceDetached(spec, { platform: 'linux', spawnDetached: never })).toBe(false);
      expect(reloadServiceDetached(spec, { platform: 'win32', spawnDetached: never })).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

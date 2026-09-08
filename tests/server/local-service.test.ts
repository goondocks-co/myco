/**
 * The unit that runs the Deployment when its owner logs in.
 *
 * Rendered rather than installed: the three platforms cannot be exercised on
 * one machine, and what a unit says is what decides whether a Deployment comes
 * back after a reboot. Each assertion below is a way a service fails quietly
 * when the unit omits it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVICE_LABEL,
  ServicePathUnsupported,
  ServicePlatformUnsupported,
  assertInstalledBinary,
  assertUnquotablePath,
  defaultSpec,
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
    expect(rendered('darwin')).toContain(SERVICE_LABEL);
    expect(servicePaths(defaultSpec(BINARY, HOME), 'darwin').unitFile)
      .toBe(join(HOME, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`));
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

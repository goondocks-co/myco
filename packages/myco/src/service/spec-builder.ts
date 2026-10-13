import fs from 'node:fs';
import path from 'node:path';
import { isDefaultMycoHome, resolveMycoHome, resolveServiceDir } from '../grove/paths.js';
import { serviceLabel } from './labels.js';
import { SERVICE_UNIT_DIR_ENV } from './paths.js';
import type { ServiceSpec, ServiceVariant } from './types.js';

export interface BuildSpecOptions {
  /** Absolute path to the daemon executable. */
  executable: string;
  /** Override MYCO_HOME (defaults to the live resolver). The daemon's whole
   *  identity — label, state dir, port — derives from this home. */
  mycoHome?: string;
  /** Platform to build the spec for; defaults to process.platform. Injected mainly for tests. */
  platform?: NodeJS.Platform;
}

import { looksLikeDevBuildExecutable } from '@myco/server/spec-builder.js';
export { looksLikeDevBuildExecutable } from '@myco/server/spec-builder.js';

export function buildServiceSpec(opts: BuildSpecOptions): ServiceSpec {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const platform = opts.platform ?? process.platform;
  const executable = path.resolve(opts.executable);

  if (!fs.existsSync(executable)) {
    throw new Error(`Service executable not found: ${executable}`);
  }
  if (executable.startsWith('/opt/homebrew/Cellar/') || executable.includes('/Cellar/')) {
    throw new Error(
      `Refusing to install service with Cellar-versioned path: ${executable}. `
      + `Use /opt/homebrew/bin/<name> or a vendored binary instead — Cellar paths break on every brew upgrade.`,
    );
  }
  const exeBase = path.basename(executable);
  if (exeBase === 'bun' || exeBase === 'bun.exe' || exeBase === 'node' || exeBase === 'node.exe') {
    throw new Error(
      `Refusing to install service with a script-runner executable: ${executable}. `
      + `Service install requires a standalone daemon binary (e.g. ~/.local/bin/myco or the dev binary at packages/myco-<arch>/bin/myco). `
      + `Start the daemon at least once with \`myco daemon\` so it records its own binary path in daemon.json, then retry.`,
    );
  }
  // Dev-build guard: the daemon in the DEFAULT home (`~/.myco`) must never run
  // a dev-build binary — that home is the production install every released
  // user shares. A non-default home (e.g. `~/.myco-dev`) is the dogfood path
  // and legitimately runs a dev-build binary. We check both the literal path
  // and its realpath so a symlink whose target lives under a vendor tree still
  // fails.
  const isDefaultHome = isDefaultMycoHome(mycoHome);
  if (isDefaultHome) {
    const candidatePaths = [executable];
    try { candidatePaths.push(fs.realpathSync(executable)); } catch { /* ignore */ }
    const offender = candidatePaths.find(looksLikeDevBuildExecutable);
    if (offender) {
      throw new Error(
        `Refusing to install the default-home (~/.myco) service with a dev-build executable: ${offender}. `
        + `Dev-build binaries (any path under packages/myco-<arch>/bin/ or legacy packages/<pkg>/vendor/) belong to a non-default home (e.g. ~/.myco-dev). `
        + `If you meant to dogfood, install into a separate MYCO_HOME. `
        + `If you intended to install the production daemon, point at the globally installed binary `
        + `(e.g. /opt/homebrew/lib/node_modules/@goondocks/myco-darwin-arm64/bin/myco) instead.`,
      );
    }
  }

  const logDir = path.join(resolveServiceDir(mycoHome), 'logs');

  const env: Record<string, string> = {
    MYCO_HOME: mycoHome,
    // Signals to the daemon that it is supervisor-managed (launchd/systemd/Task
    // Scheduler) rather than a foreground `myco daemon`. Drives the
    // phantom-bootstrap branch in main.ts (`isGlobalDaemon`). Routing identity
    // is the home (MYCO_HOME above), not a prod/dev variant.
    MYCO_DAEMON_MANAGED: '1',
    PATH: platform === 'darwin'
      ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  // Propagate the sandbox unit-dir override into the plist so a supervisor-
  // spawned child daemon does NOT fall back to `~/Library/LaunchAgents/` and
  // hijack the real user's canonical service registration. launchd / systemd
  // run RunAtLoad — the moment the parent calls `launchctl bootstrap` on the
  // sandbox plist, a child daemon comes up and re-runs ensureSelfInstalledAsService
  // during its own startup. Without this pass-through, the child computes the
  // canonical label and writes the real user's plist with sandbox MYCO_HOME paths.
  const unitDirOverride = process.env[SERVICE_UNIT_DIR_ENV]?.trim();
  if (unitDirOverride) env[SERVICE_UNIT_DIR_ENV] = unitDirOverride;

  return {
    label: serviceLabel(mycoHome),
    // Variant is derived from the home (default home → prod, else dev) for the
    // consumers that still read it (systemd unit Description, restart routing).
    // It no longer drives identity — the home does.
    variant: isDefaultHome ? 'prod' : 'dev',
    executable,
    args: ['daemon'],
    workingDir: mycoHome,
    env,
    stdoutPath: path.join(logDir, 'daemon.out.log'),
    stderrPath: path.join(logDir, 'daemon.err.log'),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

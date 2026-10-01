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

/**
 * Detect a dev-build executable path — anything compiled inside a checkout's
 * per-platform binary package (`packages/myco-<arch>/bin/myco`) or the
 * legacy pre-split `packages/<pkg>/vendor/<arch>/myco` tree.
 *
 * Used as a guard in `buildServiceSpec` (and the default-home callsite
 * fence below) to refuse installing a dev-build binary as the daemon for
 * the DEFAULT home (`~/.myco`) — the production install every released
 * user shares. Live dogfood proof of why this matters: the prod plist was
 * once overwritten with a dev-build path, after which launchd
 * re-spawned the dev binary as the prod service — running unreleased
 * code against the prod Grove with no operator visibility into the
 * substitution. Catching the substitution at build-spec time makes the
 * failure mode unreachable regardless of which caller initiated the
 * install (`myco service install`, `ensureSelfInstalledAsService`, a
 * future auto-update flow, etc.).
 *
 * Detection is intentionally a literal path match — we want to catch
 * the path *as it will be written into the plist*, before any realpath
 * resolution could flatten it. We also realpath the executable below
 * so a symlink pointing into a dev-build tree can't bypass the check.
 *
 * The installed-from-npm path always contains a `node_modules/` segment
 * (the platform package is dropped into `node_modules/@goondocks/myco-<arch>/`
 * by npm), so this regex never matches an installed binary.
 */
export function looksLikeDevBuildExecutable(executable: string): boolean {
  const platformPkgPattern = /\/packages\/myco-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)\/bin\//;
  const legacyVendorPattern = /\/packages\/[^/]+\/vendor\//;
  return platformPkgPattern.test(executable) || legacyVendorPattern.test(executable);
}

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

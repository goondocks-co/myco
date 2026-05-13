import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome, SERVICE_DEV_DIRNAME, SERVICE_DIRNAME } from '../grove/paths.js';
import { serviceLabel } from './labels.js';
import type { ServiceSpec, ServiceVariant } from './types.js';

export interface BuildSpecOptions {
  variant: ServiceVariant;
  /** Absolute path to the daemon executable. */
  executable: string;
  /** Override MYCO_HOME (defaults to the live resolver). */
  mycoHome?: string;
}

/**
 * Detect a dev-build executable path — anything inside a checkout's
 * `packages/<pkg>/vendor/<arch>/myco` tree.
 *
 * Used as a guard in `buildServiceSpec` (and the prod-only callsite
 * fence below) to refuse installing a dev-build binary as the *prod*
 * service. Live dogfood proof of why this matters: the prod plist was
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
 * so a symlink pointing into a vendor tree can't bypass the check.
 */
export function looksLikeDevBuildExecutable(executable: string): boolean {
  return /\/packages\/[^/]+\/vendor\//.test(executable);
}

export function buildServiceSpec(opts: BuildSpecOptions): ServiceSpec {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
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
      + `Service install requires a standalone daemon binary (e.g. ~/.local/bin/myco or the vendored binary at packages/myco/vendor/<arch>/myco). `
      + `Start the daemon at least once with \`myco daemon\` so it records its own binary path in daemon.json, then retry.`,
    );
  }
  // Dev-build guard: the *prod* service must never run a dev-build
  // binary. We check both the literal path and its realpath so a
  // symlink whose target lives under a vendor tree still fails.
  if (opts.variant === 'prod') {
    const candidatePaths = [executable];
    try { candidatePaths.push(fs.realpathSync(executable)); } catch { /* ignore */ }
    const offender = candidatePaths.find(looksLikeDevBuildExecutable);
    if (offender) {
      throw new Error(
        `Refusing to install the *prod* service with a dev-build executable: ${offender}. `
        + `Dev-build binaries (any path under packages/<pkg>/vendor/) belong to the *dev* service variant only. `
        + `If you meant to install the dogfood daemon, pass \`--dev\`. `
        + `If you intended to install the production daemon, point at the globally installed binary `
        + `(e.g. /opt/homebrew/lib/node_modules/@goondocks/myco/vendor/<arch>/myco) instead.`,
      );
    }
  }

  const serviceDirName = opts.variant === 'dev' ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME;
  const logDir = path.join(mycoHome, serviceDirName, 'logs');

  return {
    label: serviceLabel(opts.variant),
    variant: opts.variant,
    executable,
    args: ['daemon'],
    workingDir: mycoHome,
    env: {
      MYCO_HOME: mycoHome,
      MYCO_SERVICE_VARIANT: opts.variant,
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    },
    stdoutPath: path.join(logDir, 'daemon.out.log'),
    stderrPath: path.join(logDir, 'daemon.err.log'),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

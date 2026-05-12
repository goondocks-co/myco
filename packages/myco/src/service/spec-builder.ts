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

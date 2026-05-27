import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ServiceVariant } from './types.js';
import { isDevServiceMode, SERVICE_DIRNAME, SERVICE_DEV_DIRNAME } from '../grove/paths.js';
import { isSandboxedServiceUnitDir, resolveServiceUnitDir } from './paths.js';
import type { DaemonServiceState } from '../daemon/service-state.js';

/** Stable launchd/systemd label for the production daemon. */
export const SERVICE_LABEL_PROD = 'co.goondocks.myco';

/** Stable launchd/systemd label for the contributor dogfood daemon. */
export const SERVICE_LABEL_DEV = 'co.goondocks.myco-dev';

/**
 * When the unit dir is overridden via `MYCO_LAUNCH_AGENTS_DIR` (sandbox /
 * smoke-test installs), suffix the label with a short hash of the resolved
 * dir so the sandbox's `launchctl bootstrap` cannot clobber the real user's
 * daemon registration in the shared `gui/<uid>` domain. The plist file lands
 * in the sandbox, but launchctl still operates against the real session — so
 * the label must also be sandbox-distinct.
 */
function sandboxLabelSuffix(): string {
  if (!isSandboxedServiceUnitDir()) return '';
  const dir = resolveServiceUnitDir();
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `.sandbox-${hash}`;
}

export function serviceLabel(variant: ServiceVariant): string {
  const base = variant === 'dev' ? SERVICE_LABEL_DEV : SERVICE_LABEL_PROD;
  return `${base}${sandboxLabelSuffix()}`;
}

export function detectInstallVariant(): ServiceVariant {
  return isDevServiceMode() ? 'dev' : 'prod';
}

export function serviceVariantToDirName(variant: ServiceVariant): typeof SERVICE_DIRNAME | typeof SERVICE_DEV_DIRNAME {
  return variant === 'dev' ? SERVICE_DEV_DIRNAME : SERVICE_DIRNAME;
}

/**
 * Derive the service variant ('dev' | 'prod') from a resolved
 * `DaemonServiceState`. The variant is encoded in the state dir name:
 * `service-dev/` for contributor dogfood, `service/` for production.
 */
export function serviceVariantForState(state: DaemonServiceState): ServiceVariant {
  return path.basename(state.stateDir) === SERVICE_DEV_DIRNAME ? 'dev' : 'prod';
}

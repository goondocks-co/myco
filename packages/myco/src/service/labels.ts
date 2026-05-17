import path from 'node:path';
import type { ServiceVariant } from './types.js';
import { isDevServiceMode, SERVICE_DIRNAME, SERVICE_DEV_DIRNAME } from '../grove/paths.js';
import type { DaemonServiceState } from '../daemon/service-state.js';

/** Stable launchd/systemd label for the production daemon. */
export const SERVICE_LABEL_PROD = 'co.goondocks.myco';

/** Stable launchd/systemd label for the contributor dogfood daemon. */
export const SERVICE_LABEL_DEV = 'co.goondocks.myco-dev';

export function serviceLabel(variant: ServiceVariant): string {
  return variant === 'dev' ? SERVICE_LABEL_DEV : SERVICE_LABEL_PROD;
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

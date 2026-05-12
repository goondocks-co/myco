import type { ServiceVariant } from './types.js';

/** Stable launchd/systemd label for the production daemon. */
export const SERVICE_LABEL_PROD = 'co.goondocks.myco';

/** Stable launchd/systemd label for the contributor dogfood daemon. */
export const SERVICE_LABEL_DEV = 'co.goondocks.myco-dev';

export function serviceLabel(variant: ServiceVariant): string {
  return variant === 'dev' ? SERVICE_LABEL_DEV : SERVICE_LABEL_PROD;
}

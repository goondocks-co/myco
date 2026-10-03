/** A Deployment can accept a machine's provisioned harness health snapshot. */
export const HARNESS_HEALTH_FEATURE = 'harness-health-v1';

export const HARNESS_HEALTH_STATES = ['ready', 'binary_missing', 'unwritable', 'trust_required', 'repair_failed'] as const;
export type HarnessHealthState = (typeof HARNESS_HEALTH_STATES)[number];

export interface ProvisionedHarnessFact {
  id: string;
  provisioned: true;
  state: HarnessHealthState;
  /** Last known local use of this installed harness, in epoch milliseconds. */
  ranAt?: number;
  /** Identifies the local hook repair awaiting trust confirmation. */
  hookRepairAt?: number;
  /** One plain action the administrator can take when the state needs repair. */
  action?: string;
}

export interface ProvisionedHarnessReport {
  harnesses: ProvisionedHarnessFact[];
}

export const MAX_PROVISIONED_HARNESSES = 16;
export const MAX_HARNESS_ID_CHARS = 64;
export const MAX_HARNESS_ACTION_CHARS = 240;

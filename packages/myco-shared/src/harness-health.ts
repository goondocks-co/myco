/** A Deployment can accept a machine's provisioned harness health snapshot. */
export const HARNESS_HEALTH_FEATURE = 'harness-health-v1';

/** A harness that captured within this window is not unusually quiet. */
export const HARNESS_SILENT_MS = 24 * 60 * 60_000;
/** Allow small clock differences between local harness use and Deployment receipt. */
export const HARNESS_RUN_CAPTURE_MARGIN_MS = 5 * 60_000;
/** The longest worker run admitted by the Deployment, in seconds. */
export const MAX_WORKER_RUN_SECONDS = 60 * 60;
/** Worker exclusions outlive recent activity by the maximum run span and clock margin. */
export const HARNESS_ACTIVITY_RETENTION_MS = HARNESS_SILENT_MS + MAX_WORKER_RUN_SECONDS * 1000 + HARNESS_RUN_CAPTURE_MARGIN_MS;

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

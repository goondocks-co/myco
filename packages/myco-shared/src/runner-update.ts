/** Runner update metadata is bounded by Unicode code points on every transport. */
export const RUNNER_UPDATE_REASON_MAX = 512;
const FORBIDDEN_TEXT = /[\p{C}\p{Zl}\p{Zp}]/u;

export function isRunnerUpdateText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= max && !FORBIDDEN_TEXT.test(value);
}

/** Failure text remains displayable, bounded and nonempty. */
export function sanitizeRunnerUpdateReason(value: string): string {
  return Array.from(value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ')).slice(0, RUNNER_UPDATE_REASON_MAX).join('').trim() || 'Update failed';
}

export const RUNNER_UPDATE_RESULTS = ['updated', 'no_update', 'refused', 'rolled_back', 'failed'] as const;
export interface RunnerUpdateResult {
  requestId?: string;
  attemptId?: string;
  fromVersion: string;
  toVersion: string;
  result: (typeof RUNNER_UPDATE_RESULTS)[number];
  reason?: string;
  at: number;
}
export interface RunnerBlockedVersion { version: string; until: number; reason: string }
export interface RunnerUpdateState { phase: 'updating' | 'probation' | 'cleanup_pending'; since: number; reason?: string }
export interface RunnerUpdateReport {
  channel: 'stable' | 'beta' | 'alpha' | null;
  currentVersion: string;
  latestVersion: string | null;
  lastCheckAt: number | null;
  lastResult?: RunnerUpdateResult;
  blockedVersion?: RunnerBlockedVersion;
  updateState?: RunnerUpdateState;
}
export interface RunnerUpdateRequest { id: string; requestedAt: number; clearBlock: true }

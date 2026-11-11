export interface JobTimingPolicy { cacheMissMs: number; setupMs: number }
export function assertJobHeadroom(job: string, timeoutMinutes: number, milliseconds: number, policy?: JobTimingPolicy): void;
export function auditJobHeadroom(workflow: { jobs: Record<string, { 'timeout-minutes': number; steps: { run?: string; if?: string }[] }> }, jobs: Record<string, JobTimingPolicy & { measuredMs: number; source: string }>): void;

export function assertCoverage(actual: string[], expected: string[], label: string): void;

/** Shard and plan selectors a nested runner must not inherit from its parent. */
export const nestedRunnerEnvKeys: readonly string[];

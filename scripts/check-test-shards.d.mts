export interface JobTimingPolicy { cacheMissMs: number; setupMs: number }
export interface ViewProofWorkflow {
  jobs: {
    'view-proof': {
      strategy: { matrix: { file: string[] } };
      env: { MYCO_TEST_KIND: string; MYCO_TEST_GROUP: string };
      if?: string;
      steps: { run?: string; if?: string }[];
      'timeout-minutes': number;
    };
    check: { needs: string[] };
  };
}
export function auditViewProofJob(workflow: ViewProofWorkflow, durations: { files: Record<string, number>; jobs: { 'view-proof': JobTimingPolicy & { source: string } } }, proofs: { label: string; estimatedMs: number }[]): void;
export function assertJobHeadroom(job: string, timeoutMinutes: number, milliseconds: number, policy?: JobTimingPolicy): void;
export function auditJobHeadroom(workflow: { jobs: Record<string, { 'timeout-minutes': number; steps: { run?: string; if?: string }[] }> }, jobs: Record<string, JobTimingPolicy & { measuredMs: number; source: string }>): void;

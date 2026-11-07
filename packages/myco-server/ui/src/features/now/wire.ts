/** `GET /api/work/now`: what Myco is doing now, as `packages/myco-server/src/read/work-now.ts` answers it. */

export interface NowRunning {
  runId: string;
  projectId: string;
  task: string;
  what: string;
  machine: string | null;
  harness: string | null;
  model: string | null;
  startedAt: number | null;
  step: { words: string; at: number } | null;
}

export interface NowWaiting {
  key: string;
  projectId: string | null;
  what: string;
  count: number | null;
  why: string;
  since: number | null;
  nextAt: number | null;
}

export interface NowNeed {
  key: string;
  projectId: string | null;
  what: string;
  why: string;
  at: number;
  runId: string | null;
  retryAt: number | null;
}

export type WorkNowSection = 'running' | 'waiting' | 'needsYou';

export interface WorkNowAnswer {
  observedAt: number;
  scope: 'project' | 'deployment';
  running: NowRunning[];
  waiting: NowWaiting[];
  needsYou: NowNeed[];
  marks: { runs: string; sessions: string; fleet: string };
  unavailable: WorkNowSection[];
}

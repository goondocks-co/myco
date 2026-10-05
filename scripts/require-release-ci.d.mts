export interface CiRun {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export interface CiJob {
  name: string;
  head_sha: string;
  conclusion: string | null;
}

export function latestExactCiRun(runs: CiRun[], sha: string): CiRun | null;
export function releaseCiDecision(run: CiRun | null, jobs: CiJob[], sha: string): { state: 'waiting' | 'refused' | 'passed'; reason: string };
export function readGithubJobs(base: string, runId: number, token: string, request?: typeof fetch): Promise<CiJob[]>;

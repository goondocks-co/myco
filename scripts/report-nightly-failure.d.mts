export const NIGHTLY_ISSUE_TITLE: string;
export function failedJobs(jobs: { name: string; conclusion: string | null }[]): string[];
export function nightlyIssueBody(input: { sha: string; runUrl: string; jobs: string[] }): string;
export function reportNightlyFailure(input: {
  repo: string; runId: string; sha: string; runUrl: string; token: string;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ action: 'opened' | 'updated'; issue: number; jobs: string[] }>;

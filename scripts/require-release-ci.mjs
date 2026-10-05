import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKFLOW = 'ci.yml';
const AGGREGATE_JOB = 'check';
const POLL_MS = 20_000;
const MAX_WAIT_MS = 40 * 60_000;

export function latestExactCiRun(runs, sha) {
  return runs
    .filter((run) => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

export function releaseCiDecision(run, jobs, sha) {
  if (run === null) return { state: 'waiting', reason: `no main push CI run for ${sha}` };
  if (run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push') {
    return { state: 'refused', reason: 'CI run belongs to another commit or event' };
  }
  if (run.status !== 'completed') return { state: 'waiting', reason: `CI run ${run.id} is ${run.status}` };
  if (run.conclusion !== 'success') return { state: 'refused', reason: `CI run ${run.id} concluded ${run.conclusion}` };
  const checks = jobs.filter((job) => job.name === AGGREGATE_JOB && job.head_sha === sha);
  if (checks.length !== 1 || checks[0].conclusion !== 'success') {
    return { state: 'refused', reason: `CI run ${run.id} has no successful ${AGGREGATE_JOB} aggregate for ${sha}` };
  }
  return { state: 'passed', reason: `CI run ${run.id} and its ${AGGREGATE_JOB} aggregate succeeded for ${sha}` };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub Actions API ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('tag checkout did not resolve to a commit SHA');
  const base = `/repos/${repo}/actions`;
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const query = new URLSearchParams({ branch: 'main', event: 'push', head_sha: sha, per_page: '100' });
    const runs = await githubJson(`${base}/workflows/${WORKFLOW}/runs?${query}`, token);
    const run = latestExactCiRun(runs.workflow_runs ?? [], sha);
    const jobs = run?.status === 'completed' && run.conclusion === 'success'
      ? (await githubJson(`${base}/runs/${run.id}/jobs?filter=latest&per_page=100`, token)).jobs ?? []
      : [];
    const decision = releaseCiDecision(run, jobs, sha);
    process.stdout.write(`${decision.reason}\n`);
    if (decision.state === 'passed') return;
    if (decision.state === 'refused' || Date.now() >= deadline) {
      throw new Error(`release refused: ${decision.reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

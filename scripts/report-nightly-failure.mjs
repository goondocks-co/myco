import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGithubJobs } from './require-release-ci.mjs';

export const NIGHTLY_ISSUE_TITLE = 'Nightly full CI is failing';
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

/** The failing leaf jobs of a run: the aggregate `check` only repeats them. */
export function failedJobs(jobs) {
  return jobs.filter(job => FAILED.has(job.conclusion) && !/(^|\/ )check$/.test(job.name)).map(job => job.name).sort();
}

export function nightlyIssueBody({ sha, runUrl, jobs }) {
  const list = jobs.length > 0 ? jobs.map(name => `- ${name}`).join('\n') : '- (no failing job named; open the run)';
  return `Commit: ${sha}\nRun: ${runUrl}\n\nFailed jobs:\n${list}\n`;
}

async function github(path, token, request, init = {}) {
  const response = await request(`https://api.github.com${path}`, { ...init, headers: {
    accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
  } });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function findOpenIssue(repo, token, request) {
  for (let page = 1; ; page += 1) {
    const issues = await github(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, token, request);
    const found = issues.find(issue => issue.title === NIGHTLY_ISSUE_TITLE && issue.pull_request === undefined);
    if (found !== undefined) return found;
    if (issues.length < 100) return null;
  }
}

/** Open the one nightly failure issue, or update it and leave a comment when it is already open. */
export async function reportNightlyFailure({ repo, runId, sha, runUrl, token, request = fetch }) {
  const jobs = failedJobs(await readGithubJobs(`/repos/${repo}/actions`, runId, token, request));
  const body = nightlyIssueBody({ sha, runUrl, jobs });
  const existing = await findOpenIssue(repo, token, request);
  const post = (path, method, payload) => github(path, token, request, { method, body: JSON.stringify(payload) });
  if (existing === null) {
    const created = await post(`/repos/${repo}/issues`, 'POST', { title: NIGHTLY_ISSUE_TITLE, body });
    return { action: 'opened', issue: created.number, jobs };
  }
  await post(`/repos/${repo}/issues/${existing.number}`, 'PATCH', { body });
  await post(`/repos/${repo}/issues/${existing.number}/comments`, 'POST', { body });
  return { action: 'updated', issue: existing.number, jobs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, GITHUB_SERVER_URL: server, GITHUB_TOKEN: token } = process.env;
  if (!repo || !runId || !sha || !server || !token) {
    process.stderr.write('GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_SERVER_URL and GITHUB_TOKEN are required\n');
    process.exitCode = 1;
  } else {
    reportNightlyFailure({ repo, runId, sha, runUrl: `${server}/${repo}/actions/runs/${runId}`, token }).then(result => {
      process.stdout.write(`Nightly failure issue #${result.issue} ${result.action}: ${result.jobs.join(', ') || 'no job named'}\n`);
    }).catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}

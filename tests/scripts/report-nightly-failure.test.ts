import { expect, test } from 'bun:test';
import { NIGHTLY_ISSUE_TITLE, reportNightlyFailure } from '../../scripts/report-nightly-failure.mjs';

const SHA = 'a'.repeat(40);
const RUN_URL = 'https://github.com/org/repo/actions/runs/42';

function github(openIssues: { number: number; title: string; pull_request?: unknown }[]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const jobs = [
    { name: 'full / check', conclusion: 'failure' },
    { name: 'full / parity (3/7)', conclusion: 'failure' },
    { name: 'full / windows-native', conclusion: 'cancelled' },
    { name: 'full / lint', conclusion: 'success' },
  ];
  const request = async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (pathname.endsWith('/jobs')) return json({ jobs, total_count: jobs.length });
    if (method === 'GET') return json(openIssues);
    calls.push({ method, path: pathname, body: JSON.parse(String(init?.body)) });
    return json({ number: 77 });
  };
  return { calls, request };
}

const input = { repo: 'org/repo', runId: '42', sha: SHA, runUrl: RUN_URL, token: 't' };

test('a failed nightly with no open issue opens one naming the failed jobs and commit', async () => {
  const { calls, request } = github([]);
  const result = await reportNightlyFailure({ ...input, request });
  expect(result).toEqual({ action: 'opened', issue: 77, jobs: ['full / parity (3/7)', 'full / windows-native'] });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'POST', path: '/repos/org/repo/issues', body: { title: NIGHTLY_ISSUE_TITLE } });
  const { body } = calls[0]!.body as { body: string };
  expect(body).toContain(SHA);
  expect(body).toContain(RUN_URL);
  expect(body).toContain('- full / parity (3/7)');
  expect(body).toContain('- full / windows-native');
  expect(body).not.toContain('full / check');
});

test('another failed nightly updates the one open issue instead of opening a second', async () => {
  const { calls, request } = github([
    { number: 5, title: 'Something else' },
    { number: 9, title: NIGHTLY_ISSUE_TITLE },
  ]);
  const result = await reportNightlyFailure({ ...input, request });
  expect(result).toMatchObject({ action: 'updated', issue: 9 });
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['PATCH /repos/org/repo/issues/9', 'POST /repos/org/repo/issues/9/comments']);
  expect((calls[1]!.body as { body: string }).body).toContain(SHA);
});

test('a pull request with the same title is not taken for the nightly issue', async () => {
  const { calls, request } = github([{ number: 3, title: NIGHTLY_ISSUE_TITLE, pull_request: {} }]);
  const result = await reportNightlyFailure({ ...input, request });
  expect(result.action).toBe('opened');
  expect(calls[0]!.path).toBe('/repos/org/repo/issues');
});

test('a GitHub refusal fails the report rather than losing the failure', async () => {
  const request = async () => new Response('{}', { status: 403 });
  await expect(reportNightlyFailure({ ...input, request })).rejects.toThrow('403');
});

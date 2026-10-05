import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { latestExactCiRun, releaseCiDecision } from '../../scripts/require-release-ci.mjs';

const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const release = YAML.parse(readFileSync('.github/workflows/publish.yml', 'utf8'));

function assertAggregate(workflow: typeof ci): void {
  const jobs = Object.keys(workflow.jobs).filter((job) => job !== 'check');
  expect(new Set(workflow.jobs.check.needs)).toEqual(new Set(jobs));
  expect(workflow.jobs.check.if).toBe('always()');
  expect(workflow.jobs.check.steps[0].run).toContain('.result == "success"');
  for (const job of ['lint', 'build', 'tests', 'parity', 'self-hosted-container', 'windows-native', 'ui-screens', 'hook-startup', 'hook-startup-windows']) {
    expect(workflow.jobs[job]).toBeDefined();
    expect(workflow.jobs.check.needs).toContain(job);
  }
}

function assertPublication(workflow: typeof release): void {
  expect(workflow.jobs['require-ci'].steps.some((step: { run?: string }) => step.run?.includes('scripts/require-release-ci.mjs'))).toBe(true);
  for (const job of ['create-release', 'publish']) {
    expect(workflow.jobs[job].needs).toContain('require-ci');
    expect(workflow.jobs[job].if).toContain("needs.require-ci.result == 'success'");
  }
}

test('the canonical CI aggregate requires every verification job, including parity and shipped runtimes', () => {
  assertAggregate(ci);
  expect(ci.jobs.parity.steps.some((step: { run?: string }) => step.run === 'npm run test:parity')).toBe(true);
});

test.skipIf(process.platform === 'win32')('the actual aggregate command refuses every unsuccessful dependency', () => {
  const execute = (results: Record<string, { result: string }>) => {
    const child = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', ci.jobs.check.steps[0].run], {
      env: { ...process.env, RESULTS: JSON.stringify(results) }, encoding: 'utf8',
    });
    if (child.error) throw child.error;
    return child;
  };
  const green = Object.fromEntries(ci.jobs.check.needs.map((job: string) => [job, { result: 'success' }]));
  expect(execute(green).status).toBe(0);
  for (const job of ci.jobs.check.needs) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(execute({ ...green, [job]: { result } }).status).toBe(1);
    }
  }
});

test('every publication path requires a successful exact-SHA CI gate', () => {
  assertPublication(release);
});

test('workflow mutations that bypass parity or the publication dependency fail the contract', () => {
  const parityOmitted = structuredClone(ci);
  parityOmitted.jobs.check.needs = parityOmitted.jobs.check.needs.filter((job: string) => job !== 'parity');
  expect(() => assertAggregate(parityOmitted)).toThrow();
  const browserOmitted = structuredClone(ci);
  delete browserOmitted.jobs['ui-screens'];
  browserOmitted.jobs.check.needs = browserOmitted.jobs.check.needs.filter((job: string) => job !== 'ui-screens');
  expect(() => assertAggregate(browserOmitted)).toThrow();
  const dependencyOmitted = structuredClone(release);
  dependencyOmitted.jobs.publish.needs = dependencyOmitted.jobs.publish.needs.filter((job: string) => job !== 'require-ci');
  expect(() => assertPublication(dependencyOmitted)).toThrow();
  const conditionOmitted = structuredClone(release);
  conditionOmitted.jobs['create-release'].if = conditionOmitted.jobs['create-release'].if.replace("needs.require-ci.result == 'success' &&", '');
  expect(() => assertPublication(conditionOmitted)).toThrow();
});

test('ordinary tests passing cannot publish when parity or runtime makes the aggregate fail', () => {
  const sha = 'a'.repeat(40);
  const run = { id: 1641, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure' };
  for (const failed of ['parity', 'self-hosted-container', 'windows-native', 'hook-startup']) {
    const results = Object.fromEntries(ci.jobs.check.needs.map((job: string) => [job, { result: job === failed ? 'failure' : 'success' }]));
    expect(results.tests.result).toBe('success');
    expect(Object.values(results).every((value: { result: string }) => value.result === 'success')).toBe(false);
    expect(releaseCiDecision(run, [{ name: 'tests (node, 1/5)', head_sha: sha, conclusion: 'success' }], sha).state).toBe('refused');
  }
  expect(releaseCiDecision(null, [], sha).state).toBe('waiting');
  expect(releaseCiDecision({ ...run, conclusion: 'success' }, [{ name: 'check', head_sha: sha, conclusion: 'failure' }], sha).state).toBe('refused');
  expect(releaseCiDecision({ ...run, conclusion: 'success' }, [{ name: 'check', head_sha: sha, conclusion: 'skipped' }], sha).state).toBe('refused');
  expect(releaseCiDecision({ ...run, conclusion: 'success' }, [{ name: 'check', head_sha: 'b'.repeat(40), conclusion: 'success' }], sha).state).toBe('refused');
  expect(releaseCiDecision({ ...run, conclusion: 'success' }, [{ name: 'check', head_sha: sha, conclusion: 'success' }], sha).state).toBe('passed');
  expect(releaseCiDecision({ ...run, head_sha: 'b'.repeat(40), conclusion: 'success' }, [{ name: 'check', head_sha: sha, conclusion: 'success' }], sha).state).toBe('refused');
  expect(latestExactCiRun([{ ...run, id: 1, conclusion: 'success' }, { ...run, id: 2 },
    { ...run, id: 3, head_sha: 'b'.repeat(40) }], sha)?.id).toBe(2);
});

test('CI runs the real container preservation and destructive-image gates', () => {
  const workflow = ci.jobs['self-hosted-container'];
  expect(workflow.steps.some((step: { run?: string }) => step.run?.includes('scripts/smoke-container-persistence.mjs'))).toBe(true);
  expect(workflow.steps.some((step: { run?: string }) => step.run?.includes('scripts/test-container-persistence-mutations.mjs'))).toBe(true);
});

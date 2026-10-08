import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { latestExactCiRun, releaseCiDecision } from '../../scripts/require-release-ci.mjs';

const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const release = YAML.parse(readFileSync('.github/workflows/publish.yml', 'utf8'));

function assertDarwinDistribution(workflow: typeof release): void {
  const signing = workflow.jobs['sign-darwin'];
  expect(signing['runs-on']).toBe('macos-14');
  expect(signing.needs).toContain('cross-compile');
  expect(signing.strategy.matrix.target).toEqual(['darwin-arm64', 'darwin-x64']);
  const download = signing.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'));
  const sign = signing.steps.findIndex((step: { run?: string }) => step.run?.includes('codesign --force --sign - --preserve-metadata=entitlements,identifier binary/myco'));
  const upload = signing.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(sign).toBeGreaterThan(download);
  expect(download).toBeGreaterThanOrEqual(0);
  expect(upload).toBeGreaterThan(sign);
  expect(signing.steps[upload].with).toMatchObject({
    name: 'myco-binary-${{ matrix.target }}', path: 'binary/', overwrite: true, 'if-no-files-found': 'error',
  });
  expect(signing.steps[download].with).toMatchObject({ name: 'myco-binary-${{ matrix.target }}', path: 'binary/' });
  expect(workflow.jobs.build.needs).toContain('sign-darwin');
  expect(workflow.jobs.build.if).toContain("needs.sign-darwin.result == 'success'");
  expect(workflow.jobs.build.if).toContain("needs.validate-tag.outputs.tag_prefix != 'myco' && needs.sign-darwin.result == 'skipped'");
  expect(workflow.jobs.build.steps.some((step: { uses?: string; with?: { pattern?: string } }) =>
    step.uses?.startsWith('actions/download-artifact@') && step.with?.pattern === 'myco-binary-*')).toBe(true);
  expect(workflow.jobs.build.steps.find((step: { name?: string }) => step.name === 'Verify platform binaries').run).toContain('chmod +x "$binary"');
  const gate = workflow.jobs['verify-darwin'];
  expect(gate['runs-on']).toBe('macos-14');
  expect(gate.needs).toContain('build');
  expect(gate.if).toBe("needs.validate-tag.outputs.tag_prefix == 'myco'");
  for (const artifact of ['myco-raw-binaries', 'npm-package']) {
    expect(gate.steps.some((step: { uses?: string; with?: { name?: string } }) =>
      step.uses?.startsWith('actions/download-artifact@') && step.with?.name === artifact)).toBe(true);
  }
  const verify = gate.steps.find((step: { run?: string }) => step.run?.includes('scripts/verify-darwin-distribution.sh'));
  expect(verify.env.VERSION).toBe('${{ needs.validate-tag.outputs.version }}');
  expect(verify.run).toContain('for target in darwin-arm64 darwin-x64');
  expect(verify.run).toContain('"npm-packages/myco-${target}/goondocks-myco-${target}-"*.tgz');
  expect(verify.run).toContain('"raw-binaries/myco-${target}" "${tarballs[0]}" "$mode"');
  expect(verify.run).toContain('mode=native');
  for (const job of ['create-release', 'publish']) {
    expect(workflow.jobs[job].needs).toContain('verify-darwin');
    expect(workflow.jobs[job].if).toContain("needs.verify-darwin.result == 'success'");
    expect(workflow.jobs[job].if).toContain("needs.validate-tag.outputs.tag_prefix != 'myco' && needs.verify-darwin.result == 'skipped'");
  }
}

test('macOS signing precedes staging, npm packing and checksums; exact distributions gate all publication', () => {
  assertDarwinDistribution(release);
  const script = readFileSync('scripts/verify-darwin-distribution.sh', 'utf8');
  expect(script).toContain('tar -xzf "$tarball" -C "$scratch" package/bin/myco');
  expect(script).toContain('cmp "$asset" "$packed"');
  expect(script).toContain('for binary in "$asset" "$packed"');
  expect(script).toContain('codesign --verify --strict "$binary"');
  expect(script).toContain('actual="$("$binary" --version)"');
  expect(script).toContain('[ "$actual" != "$version" ]');
});

test('removing signing, signing after pack or checksum, and removing the macOS gate fail the release contract', () => {
  for (const destination of ['omit', 'pack', 'checksum']) {
    const mutant = structuredClone(release);
    const steps = mutant.jobs['sign-darwin'].steps;
    const index = steps.findIndex((step: { run?: string }) => step.run?.includes('codesign --force --sign -'));
    const [sign] = steps.splice(index, 1);
    if (destination === 'pack') mutant.jobs.build.steps.push(sign);
    if (destination === 'checksum') mutant.jobs['create-release'].steps.push(sign);
    expect(() => assertDarwinDistribution(mutant)).toThrow();
  }
  const noGate = structuredClone(release);
  delete noGate.jobs['verify-darwin'];
  expect(() => assertDarwinDistribution(noGate)).toThrow();
  for (const job of ['create-release', 'publish']) {
    const bypass = structuredClone(release);
    bypass.jobs[job].needs = bypass.jobs[job].needs.filter((name: string) => name !== 'verify-darwin');
    expect(() => assertDarwinDistribution(bypass)).toThrow();
  }
  const unsignedInput = structuredClone(release);
  unsignedInput.jobs.build.needs = unsignedInput.jobs.build.needs.filter((name: string) => name !== 'sign-darwin');
  expect(() => assertDarwinDistribution(unsignedInput)).toThrow();
});

test('main and PR darwin builds sign and verify both raw and npm-packed binaries', () => {
  expect(ci.on.push.branches).toContain('main');
  expect(ci.on.pull_request.branches).toContain('main');
  const hook = ci.jobs['hook-startup'];
  expect(hook.strategy.matrix.include).toContainEqual({ target: 'darwin-arm64', os: 'macos-14', rg: 'darwin-arm64', ceiling: 150 });
  const steps = hook.steps;
  const compile = steps.findIndex((step: { run?: string }) => step.run?.includes('npm run build:binary'));
  const gate = steps.findIndex((step: { run?: string }) => step.run?.includes('scripts/verify-darwin-distribution.sh'));
  const version = steps.findIndex((step: { run?: string }) => step.run === 'node scripts/sync-package-versions.mjs --target myco --version 0.0.0-ci');
  expect(version).toBeGreaterThanOrEqual(0);
  expect(version).toBeLessThan(compile);
  expect(steps[version].if).toBe("matrix.target == 'darwin-arm64'");
  expect(gate).toBeGreaterThan(compile);
  expect(compile).toBeGreaterThanOrEqual(0);
  expect(steps[gate].if).toBe("matrix.target == 'darwin-arm64'");
  expect(readFileSync('packages/myco/scripts/build-single-target.mjs', 'utf8')).toContain('signExecutable({ target, outfile })');
  expect(readFileSync('packages/myco/scripts/sign-executable.mjs', 'utf8')).toContain("'--preserve-metadata=entitlements,identifier'");
  expect(steps[gate].run).toContain('"${tarballs[0]}" native');
});

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

function assertRoutingSmoke(workflow: typeof ci): void {
  const build = workflow.jobs.build.steps;
  const smoke = build.findIndex((step: { run?: string }) => step.run === 'npm test -- tests/member/rbac-routing-smoke.test.ts');
  const compile = build.findIndex((step: { run?: string }) => step.run?.includes('npm run build'));
  expect(smoke).toBeGreaterThan(compile);
  expect(compile).toBeGreaterThanOrEqual(0);
  expect(build.some((step: { uses?: string; with?: { name?: string; 'if-no-files-found'?: string } }) =>
    step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'rbac-routing-linux-x64' && step.with['if-no-files-found'] === 'error')).toBe(true);
  expect(workflow.jobs.tests.needs).toBe('build');
  expect(workflow.jobs.tests.steps.some((step: { uses?: string; with?: { name?: string } }) =>
    step.uses?.startsWith('actions/download-artifact@') && step.with?.name === 'rbac-routing-linux-x64')).toBe(true);
}

test('routing runs with the built binary, and full node shards receive that binary', () => {
  assertRoutingSmoke(ci);
  const omitted = structuredClone(ci);
  omitted.jobs.build.steps = omitted.jobs.build.steps.filter((step: { run?: string }) => step.run !== 'npm test -- tests/member/rbac-routing-smoke.test.ts');
  expect(() => assertRoutingSmoke(omitted)).toThrow();
  const missing = structuredClone(ci);
  missing.jobs.tests.steps = missing.jobs.tests.steps.filter((step: { uses?: string }) => !step.uses?.startsWith('actions/download-artifact@'));
  expect(() => assertRoutingSmoke(missing)).toThrow();
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

const releaseCliPreload = String.raw`
const fixture = JSON.parse(process.env.MYCO_RELEASE_CI_FIXTURE);
const jobsPath = '/repos/goondocks/myco/actions/runs/42/jobs';
const pageTwo = 'https://api.github.com' + jobsPath + '?filter=latest&per_page=100&page=2';
const check = { name: 'check', head_sha: fixture.sha, conclusion: 'success' };
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.github.com' || options.headers.authorization !== 'Bearer fixture-token') {
    throw new Error('release gate requested an unexpected API origin or credential');
  }
  if (url.pathname.endsWith('/workflows/ci.yml/runs')) {
    if (url.searchParams.get('head_sha') !== fixture.sha) throw new Error('release gate queried another commit');
    return Response.json({ workflow_runs: [{
      id: 42, head_sha: fixture.sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
    }] });
  }
  if (url.pathname !== jobsPath || url.searchParams.get('filter') !== 'latest' || url.searchParams.get('per_page') !== '100') {
    throw new Error('release gate requested an unexpected jobs listing');
  }
  if (url.searchParams.get('page') === '1') {
    const jobs = Array.from({ length: 100 }, (_, index) => ({ name: 'job-' + index, head_sha: fixture.sha, conclusion: 'success' }));
    if (fixture.scenario === 'extra-link') jobs[0] = check;
    const link = '<' + (fixture.scenario === 'hostile-link' ? pageTwo.replace('api.github.com', 'evil.example.com') : pageTwo) + '>; rel="next"';
    return Response.json({ total_count: fixture.scenario === 'extra-link' ? 100 : 101, jobs }, { headers: { link } });
  }
  if (url.searchParams.get('page') === '2') {
    if (fixture.scenario === 'extra-link') return Response.json({ total_count: 100, jobs: [] });
    return Response.json({ total_count: 101, jobs: [check] }, { status: fixture.scenario === 'api-error' ? 503 : 200 });
  }
  throw new Error('release gate requested an unexpected page');
};
`;

function releaseCli(scenario: 'page-two' | 'api-error' | 'hostile-link' | 'extra-link') {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) throw new Error(`cannot resolve test commit: ${head.stderr}`);
  const child = spawnSync('node', ['--import', `data:text/javascript,${encodeURIComponent(releaseCliPreload)}`, 'scripts/require-release-ci.mjs'], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'goondocks/myco', GITHUB_TOKEN: 'fixture-token',
      MYCO_RELEASE_CI_FIXTURE: JSON.stringify({ scenario, sha: head.stdout.trim() }),
    },
    encoding: 'utf8', timeout: 10_000,
  });
  if (child.error) throw child.error;
  return child;
}

test('release CLI admits the aggregate on the second latest-jobs page', () => {
  const child = releaseCli('page-two');
  expect(child.status).toBe(0);
  expect(child.stdout).toContain('and its check aggregate succeeded');
});

test('release CLI refuses an API error on the second jobs page', () => {
  const child = releaseCli('api-error');
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('returned HTTP 503');
});

test('release CLI refuses an untrusted next-page URL', () => {
  const child = releaseCli('hostile-link');
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('outside the required latest-job listing');
});

test('release CLI refuses a next page beyond the reported job count', () => {
  const child = releaseCli('extra-link');
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('links beyond total_count');
});

test('CI runs the real container preservation and destructive-image gates', () => {
  const workflow = ci.jobs['self-hosted-container'];
  expect(workflow.steps.some((step: { run?: string }) => step.run?.includes('scripts/smoke-container-persistence.mjs'))).toBe(true);
  expect(workflow.steps.some((step: { run?: string }) => step.run?.includes('scripts/test-container-persistence-mutations.mjs'))).toBe(true);
});

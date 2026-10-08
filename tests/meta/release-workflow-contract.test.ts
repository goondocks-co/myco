import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import fs, { mkdtempSync, rmSync } from '../support/fenced-fs.mjs';
import { CLIENTS } from '../../packages/myco/scripts/gen-plugin-bundle.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { latestExactCiRun, releaseCiDecision } from '../../scripts/require-release-ci.mjs';
import { requiresDarwinRecipe } from '../../scripts/darwin-release-inputs.mjs';

const ci = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const release = YAML.parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const SIGN_DARWIN = 'bash scripts/sign-darwin-binary.sh binary/myco';

function assertFailureIsTerminal(job: typeof release.jobs.build): void {
  expect(job).not.toHaveProperty('continue-on-error');
  for (const step of job.steps) {
    expect(step).not.toHaveProperty('continue-on-error');
    if (step.run) expect(step.run).not.toMatch(/\|\|\s*(?:true|:)(?:\s|;|$)|\bset\s+\+e\b/);
  }
}

function assertDarwinDistribution(workflow: typeof release): void {
  const signing = workflow.jobs['sign-darwin'];
  assertFailureIsTerminal(signing);
  expect(signing['runs-on']).toBe('macos-14');
  expect(signing.needs).toContain('cross-compile');
  expect(signing.strategy.matrix.target).toEqual(['darwin-arm64', 'darwin-x64']);
  const download = signing.steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'));
  const sign = signing.steps.findIndex((step: { run?: string }) => step.run === SIGN_DARWIN);
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
  assertFailureIsTerminal(gate);
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
  expect(script).toContain('asset_sha="$(shasum -a 256 "$asset")"');
  expect(script).toContain('packed_sha="$(shasum -a 256 "$packed")"');
  expect(script).toContain('[ "${asset_sha%% *}" != "${packed_sha%% *}" ]');
  expect(script).toContain('for binary in "$asset" "$packed"');
  expect(script).toContain('codesign --verify --strict "$binary"');
  expect(script).toContain('actual="$(cd "$scratch" && "$binary" --version)"');
  expect(script.indexOf('codesign --verify --strict')).toBeLessThan(script.indexOf('shasum -a 256'));
  expect(script).toContain('invalid code signature; refusing distribution verification');
  expect(script).toContain('[ "$actual" != "$version" ]');
  const signer = readFileSync('scripts/sign-darwin-binary.sh', 'utf8');
  expect(signer).toContain('codesign --force --sign - --preserve-metadata=entitlements,identifier "$binary"');
  for (const source of [script, signer]) expect(source).not.toMatch(/\|\|\s*(?:true|:)(?:\s|;|$)|\bset\s+\+e\b/);
});

test('the needs graph and step order reject signing relocated after real npm pack or checksum steps', () => {
  for (const destination of ['omit', 'pack', 'checksum']) {
    const mutant = structuredClone(release);
    const steps = mutant.jobs['sign-darwin'].steps;
    const index = steps.findIndex((step: { run?: string }) => step.run === SIGN_DARWIN);
    const [sign] = steps.splice(index, 1);
    if (destination !== 'omit') {
      const recipient = destination === 'pack' ? mutant.jobs.build : mutant.jobs['create-release'];
      const predecessor = recipient.steps.findIndex((step: { run?: string }) =>
        step.run?.includes(destination === 'pack' ? 'npm pack --json' : 'sha256sum myco-darwin-arm64'));
      expect(predecessor).toBeGreaterThanOrEqual(0);
      recipient.steps.splice(predecessor + 1, 0, sign);
      expect(recipient.steps[predecessor + 1].run).toBe(SIGN_DARWIN);
      mutant.jobs['sign-darwin'].needs = destination === 'pack' ? ['build'] : ['create-release'];
    }
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

test('continue-on-error and swallowed signing or verification failures are rejected at job and step scope', () => {
  for (const name of ['sign-darwin', 'verify-darwin']) {
    const relaxed = structuredClone(release);
    relaxed.jobs[name]['continue-on-error'] = true;
    expect(() => assertDarwinDistribution(relaxed)).toThrow();
    for (let index = 0; index < release.jobs[name].steps.length; index++) {
      const relaxedStep = structuredClone(release);
      relaxedStep.jobs[name].steps[index]['continue-on-error'] = true;
      expect(() => assertDarwinDistribution(relaxedStep)).toThrow();
    }
    for (const swallow of [' || true', ' || :', '\nset +e\n']) {
      const ignored = structuredClone(release);
      const step = ignored.jobs[name].steps.find((candidate: { run?: string }) => candidate.run);
      step.run += swallow;
      expect(() => assertDarwinDistribution(ignored)).toThrow();
    }
  }
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

function assertCrossCompiledDarwin(workflow: typeof ci): void {
  const build = workflow.jobs['darwin-release-build'];
  const verify = workflow.jobs['darwin-release-verify'];
  assertFailureIsTerminal(build);
  assertFailureIsTerminal(verify);
  expect(build['runs-on']).toBe('ubuntu-latest');
  expect(build.needs).toEqual(['build', 'hook-startup']);
  expect(build.if).toBe("needs.build.outputs.darwin_distribution_required == 'true'");
  expect(build.steps.some((step: { run?: string }) => step.run === 'TARGET=darwin-arm64 npm run build:binary -w @goondocks/myco')).toBe(true);
  expect(build.steps.some((step: { run?: string }) => step.run === 'npm ci --ignore-scripts')).toBe(true);
  expect(build.steps.some((step: { uses?: string; with?: { name?: string } }) =>
    step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'ci-myco-cross-darwin-arm64')).toBe(true);
  expect(verify['runs-on']).toBe('macos-14');
  expect(verify.needs).toEqual(['build', 'darwin-release-build']);
  expect(verify.if).toBe(build.if);
  expect(verify.steps.some((step: { uses?: string; with?: { name?: string } }) =>
    step.uses?.startsWith('actions/download-artifact@') && step.with?.name === 'ci-myco-cross-darwin-arm64')).toBe(true);
  const sign = verify.steps.findIndex((step: { run?: string }) => step.run === SIGN_DARWIN);
  const gate = verify.steps.findIndex((step: { run?: string }) => step.run?.includes('scripts/verify-darwin-distribution.sh'));
  expect(sign).toBeGreaterThanOrEqual(0);
  expect(gate).toBeGreaterThan(sign);
  expect(verify.steps[gate].run).toContain('0.0.0-ci binary/myco target/darwin-release/goondocks-myco-darwin-arm64-0.0.0-ci.tgz native');
  expect(workflow.jobs.build.outputs.darwin_distribution_required).toBe('${{ steps.darwin-inputs.outputs.required }}');
  expect(workflow.jobs.build.steps.some((step: { run?: string; id?: string }) =>
    step.id === 'darwin-inputs' && step.run === 'node scripts/darwin-release-inputs.mjs')).toBe(true);
}

test('CI cross-compiles on Linux and invokes the release signing entry point on macOS before packing and executing', () => {
  assertCrossCompiledDarwin(ci);
  expect(release.jobs['sign-darwin'].steps.some((step: { run?: string }) => step.run === SIGN_DARWIN)).toBe(true);
  for (const mutation of ['native-build', 'drifted-signing', 'ignored-failure']) {
    const changed = structuredClone(ci);
    if (mutation === 'native-build') changed.jobs['darwin-release-build']['runs-on'] = 'macos-14';
    if (mutation === 'drifted-signing') changed.jobs['darwin-release-verify'].steps.find((step: { run?: string }) => step.run === SIGN_DARWIN).run = 'codesign --force --sign - binary/myco';
    if (mutation === 'ignored-failure') changed.jobs['darwin-release-verify']['continue-on-error'] = true;
    expect(() => assertCrossCompiledDarwin(changed)).toThrow();
  }
});

test('release recipe runs on every main push and build or release changes; unrelated PRs can skip it', () => {
  expect(requiresDarwinRecipe('push', [])).toBe(true);
  expect(requiresDarwinRecipe('pull_request', ['docs/ci.md'])).toBe(false);
  for (const path of ['.github/workflows/ci.yml', '.github/actions/ci-setup/action.yml', 'scripts/sign-darwin-binary.sh',
    'packages/myco/scripts/build-single-target.mjs', 'package.json', 'package-lock.json',
    'packages/myco-darwin-arm64/package.json', 'packages/myco-server/ui/package-lock.json', '.bun-version']) {
    expect(requiresDarwinRecipe('pull_request', [path])).toBe(true);
  }
  expect(() => requiresDarwinRecipe('pull_request_target', [])).toThrow();
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
  const gate = workflow.jobs['require-ci'];
  assertFailureIsTerminal(gate);
  expect(gate).not.toHaveProperty('if');
  const invocation = gate.steps.find((step: { run?: string }) => step.run?.includes('scripts/require-release-ci.mjs'));
  expect(invocation.run).toBe('node scripts/require-release-ci.mjs');
  expect(invocation.if).toBe("github.event_name == 'push'");
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
  const execute = (results: Record<string, { result: string }>, required = 'true') => {
    const child = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', ci.jobs.check.steps[0].run], {
      env: { ...process.env, RESULTS: JSON.stringify(results), DARWIN_DISTRIBUTION_REQUIRED: required }, encoding: 'utf8',
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
  const notRequired = { ...green, 'darwin-release-build': { result: 'skipped' }, 'darwin-release-verify': { result: 'skipped' } };
  expect(execute(notRequired, 'false').status).toBe(0);
  expect(execute(notRequired, 'true').status).toBe(1);
  expect(execute(notRequired, '').status).toBe(1);
  for (const result of ['failure', 'cancelled']) {
    expect(execute({ ...notRequired, 'darwin-release-verify': { result } }, 'false').status).toBe(1);
  }
  expect(execute({ ...notRequired, build: { result: 'skipped' } }, 'false').status).toBe(1);
});

test('every publication path requires a successful exact-SHA CI gate', () => {
  assertPublication(release);
  for (const mutation of ['job', 'step', ' || true', ' || :', '\nset +e\n', 'conditional']) {
    const mutant = structuredClone(release);
    const gate = mutant.jobs['require-ci'];
    const step = gate.steps.find((candidate: { run?: string }) => candidate.run?.includes('require-release-ci.mjs'));
    if (mutation === 'job') gate['continue-on-error'] = true;
    else if (mutation === 'step') step['continue-on-error'] = true;
    else if (mutation === 'conditional') step.if += ' && false';
    else step.run += mutation;
    expect(() => assertPublication(mutant)).toThrow();
  }
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


function publicationAllowed(workflow: typeof release, job: string, event: string, ref: string, dryRun: string): boolean {
  const expression = workflow.jobs['validate-tag'].outputs.publication_allowed.slice(3, -2);
  const github = { event_name: event, ref };
  const startsWith = (value: string, prefix: string) => value.startsWith(prefix);
  const admitted = new Function('github', 'steps', 'startsWith', `return (${expression});`)(
    github, { extract: { outputs: { dry_run: dryRun } } }, startsWith,
  );
  const needs = Object.fromEntries(workflow.jobs[job].needs.map((name: string) => [name, {
    result: 'success', outputs: { tag_prefix: 'myco', dry_run: dryRun, publication_allowed: String(admitted) },
  }]));
  return Boolean(new Function('github', 'needs', 'always', 'startsWith',
    `return (${workflow.jobs[job].if.replace(/needs\.([\w-]+)/g, "needs['$1']")});`)(
    github, needs, () => true, startsWith,
  ));
}

function assertDryRunPublication(workflow: typeof release): void {
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
  for (const [name, job] of Object.entries<typeof release.jobs.build>(workflow.jobs)) {
    if (name !== 'publish') expect(job).not.toHaveProperty('environment');
    if (name === 'create-release' || name === 'publish') continue;
    expect(job.permissions?.contents ?? workflow.permissions.contents).toBe('read');
    expect(job.permissions?.['id-token']).not.toBe('write');
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/);
  }
  for (const job of ['create-release', 'publish']) {
    for (const event of ['pull_request', 'workflow_dispatch']) {
      for (const ref of ['refs/pull/1/merge', 'refs/heads/main', 'refs/tags/myco/v2.0.0-alpha.1']) {
        for (const dryRun of ['true', 'false', '']) {
          expect(publicationAllowed(workflow, job, event, ref, dryRun)).toBe(false);
        }
      }
    }
    expect(publicationAllowed(workflow, job, 'push', 'refs/heads/main', 'false')).toBe(false);
    expect(publicationAllowed(workflow, job, 'push', 'refs/tags/myco/v2.0.0-alpha.1', 'true')).toBe(false);
    expect(publicationAllowed(workflow, job, 'push', 'refs/tags/myco/v2.0.0-alpha.1', 'false')).toBe(true);
  }
  expect(workflow.jobs['create-release'].permissions).toEqual({ contents: 'write' });
  expect(workflow.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  expect(workflow.jobs.publish.environment).toBe('npm-publish');
}

test('PR and manual dry runs have no publication authority, even with successful dependencies', () => {
  assertDryRunPublication(release);
  for (const job of ['create-release', 'publish']) {
    const mutant = structuredClone(release);
    mutant.jobs[job].if = mutant.jobs[job].if
      .replace("needs.validate-tag.outputs.publication_allowed == 'true' &&", '');
    expect(publicationAllowed(mutant, job, 'workflow_dispatch', 'refs/heads/main', 'true')).toBe(true);
    expect(() => assertDryRunPublication(mutant)).toThrow();
  }
  const elevated = structuredClone(release);
  elevated.permissions.contents = 'write';
  expect(() => assertDryRunPublication(elevated)).toThrow();
  const credential = structuredClone(release);
  credential.jobs.build.env = { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' };
  expect(() => assertDryRunPublication(credential)).toThrow();
  const privilegedTrigger = structuredClone(release);
  privilegedTrigger.on.pull_request_target = {};
  expect(() => assertDryRunPublication(privilegedTrigger)).toThrow();
  for (const job of Object.keys(release.jobs).filter((name) => name !== 'publish')) {
    const environment = structuredClone(release);
    environment.jobs[job].environment = 'npm-publish';
    expect(() => assertDryRunPublication(environment)).toThrow();
  }
});

test('release-relevant PRs and supplied manual versions run the full distribution recipe', () => {
  expect(release.on.pull_request.branches).toContain('main');
  for (const path of ['.github/workflows/publish.yml', 'scripts/**', 'packages/myco/scripts/**',
    '**/package.json', '**/package-lock.json', '.bun-version', 'packages/myco/plugin-version.json',
    'plugins/myco/**', '.claude-plugin/marketplace.json']) {
    expect(release.on.pull_request.paths).toContain(path);
  }
  expect(release.on.workflow_dispatch.inputs.version).toMatchObject({ required: true, type: 'string' });
  for (const job of ['validate-tag', 'compile-libsqlite3', 'cross-compile', 'sign-darwin', 'build', 'verify-darwin']) {
    expect(release.jobs[job].if ?? '').not.toMatch(/github\.event_name|dry_run/);
  }
  const requireCi = release.jobs['require-ci'].steps.find((step: { run?: string }) => step.run?.includes('require-release-ci.mjs'));
  expect(requireCi.if).toBe("github.event_name == 'push'");
  const extract = release.jobs['validate-tag'].steps.find((step: { id?: string }) => step.id === 'extract');
  expect(extract.env.DRY_RUN_VERSION).toBe("${{ inputs.version || '2.0.0-alpha.1' }}");
  const scratch = mkdtempSync(join(tmpdir(), 'myco-release-validation-'));
  try {
    for (const [event, version, valid] of [
      ['pull_request', '2.0.0-alpha.1', true], ['workflow_dispatch', '2.0.0-beta.2', true],
      ['workflow_dispatch', 'bad-version', false], ['push', '2.0.0-alpha.1', true],
      ['workflow_dispatch', '2.0.0-alpha.1\npublication_allowed=true', false],
      ['workflow_dispatch', '2.0.0-alpha.1\n', false],
      ['workflow_dispatch', '2.0.0-preview.1', false],
    ] as const) {
      const output = join(scratch, 'outputs');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-eu', '-c', extract.run], { encoding: 'utf8', env: {
        ...process.env, EVENT_NAME: event, TAG_NAME: 'myco/v2.0.0-alpha.1',
        DRY_RUN_VERSION: version, DRY_RUN_PACKAGE: 'myco', GITHUB_OUTPUT: output,
      } });
      expect(result.status, result.stderr).toBe(valid ? 0 : 1);
      if (valid) {
        const values = readFileSync(output, 'utf8');
        expect(values).toContain(`version=${version}\n`);
        expect(values).toContain(`dry_run=${event !== 'push'}\n`);
        expect(values).toContain('tag_prefix=myco\n');
      } else expect(readFileSync(output, 'utf8')).toBe('');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('release verifies versioned build output after staging and delegates the suite to canonical CI', () => {
  const build = release.jobs.build.steps;
  expect(build.some((step: { run?: string }) => /npm (?:test|run lint)\b/.test(step.run ?? ''))).toBe(false);
  const sync = build.findIndex((step: { run?: string }) => step.run?.includes('sync-package-versions.mjs'));
  const generate = build.findIndex((step: { run?: string }) => step.run?.includes('gen-plugin-bundle.ts'));
  expect(generate).toBeGreaterThan(sync);
  expect(sync).toBeGreaterThanOrEqual(0);
  expect(build[generate].run).toContain('gen-plugin-bundle.ts --check');
  expect(build[generate].run).not.toMatch(/gen-plugin-bundle\.ts\s*\n/);
  assertFailureIsTerminal(release.jobs['validate-tag']);
  const pluginGate = release.jobs['validate-tag'].steps.find((step: { name?: string }) => step.name === 'Require the committed Git plugin release version');
  expect(pluginGate.if).toBe("github.event_name == 'push' && steps.extract.outputs.tag_prefix == 'myco'");
  expect(pluginGate.env.VERSION).toBe('${{ steps.extract.outputs.version }}');
  const committedVersion = JSON.parse(readFileSync('packages/myco/plugin-version.json', 'utf8')).version;
  for (const version of [committedVersion, '9999.0.0']) {
    const result = spawnSync('bash', ['-e', '-c', pluginGate.run], { env: { ...process.env, VERSION: version }, encoding: 'utf8' });
    expect(result.status).toBe(version === committedVersion ? 0 : 1);
  }
  const stage = build.findIndex((step: { name?: string }) => step.name === 'Verify platform binaries');
  const verify = build.findIndex((step: { run?: string }) => step.run === 'npm run build:verify -w @goondocks/myco');
  const pack = build.findIndex((step: { name?: string }) => step.name === 'Pack platform packages (myco)');
  const smoke = build.findIndex((step: { run?: string }) => step.run === 'node scripts/verify-release-binary.mjs packages/myco-linux-x64/bin/myco "$VERSION"');
  expect(verify).toBeGreaterThan(stage);
  expect(stage).toBeGreaterThanOrEqual(0);
  expect(pack).toBeGreaterThan(verify);
  expect(smoke).toBeGreaterThan(verify);
  expect(pack).toBeGreaterThan(smoke);
  expect(build[smoke].if).toBe("needs.validate-tag.outputs.tag_prefix == 'myco'");
  expect(build[smoke].env.VERSION).toBe('${{ needs.validate-tag.outputs.version }}');
  assertPublication(release);
  const compile = release.jobs['cross-compile'].steps;
  const compileSync = compile.findIndex((step: { run?: string }) => step.run?.includes('sync-package-versions.mjs'));
  const codegen = compile.findIndex((step: { run?: string }) => step.run === 'npm run codegen -w @goondocks/myco');
  const binary = compile.findIndex((step: { run?: string }) => step.run?.includes('npm run build:binary'));
  expect(codegen).toBeGreaterThan(compileSync);
  expect(compileSync).toBeGreaterThanOrEqual(0);
  expect(binary).toBeGreaterThan(codegen);
});


test('Git plugin versions survive npm sync, and preparation updates every committed client and marketplace', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'myco-release-codegen-'));
  try {
    for (const file of ['scripts/sync-package-versions.mjs', 'scripts/prepare-plugin-release.mjs',
      'packages/myco/package.json', 'packages/myco/plugin-version.json', 'packages/myco/scripts/release-policy.mjs',
      'packages/myco/scripts/gen-plugin-bundle.ts', 'packages/myco/scripts/codegen-bundle.mjs',
      'packages/myco/src/plugins/spec.ts', 'packages/myco/skills', 'packages/myco/evals']) {
      const destination = join(scratch, file);
      fs.mkdirSync(join(destination, '..'), { recursive: true });
      fs.cpSync(file, destination, { recursive: true });
    }
    fs.symlinkSync(join(process.cwd(), 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const generate = (check = false) => spawnSync('node', ['--import', 'tsx',
      'packages/myco/scripts/gen-plugin-bundle.ts', ...(check ? ['--check'] : [])], { cwd: scratch, encoding: 'utf8' });
    expect(generate().status).toBe(0);
    const sync = spawnSync('node', ['scripts/sync-package-versions.mjs', '--target', 'myco', '--version', '2.0.0-alpha.1'],
      { cwd: scratch, encoding: 'utf8' });
    expect(sync.status, sync.stderr).toBe(0);
    expect(generate(true).status).toBe(0);
    const prepare = (version: string) => spawnSync('node', ['scripts/prepare-plugin-release.mjs', version], { cwd: scratch, encoding: 'utf8' });
    expect(prepare('2.0.0-beta.2').status).toBe(0);
    expect(generate(true).status).toBe(0);
    for (const client of CLIENTS) {
      if (client.manifestPath === undefined) continue;
      const manifest = JSON.parse(readFileSync(join(scratch, 'plugins/myco', client.manifestPath), 'utf8'));
      expect(manifest.version).toBe('2.0.0-beta.2');
    }
    const marketplace = JSON.parse(readFileSync(join(scratch, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(marketplace.plugins[0].version).toBe('2.0.0-beta.2');
    const metadata = readFileSync(join(scratch, 'packages/myco/plugin-version.json'), 'utf8');
    expect(prepare('2.0.0-beta.2\n').status).toBe(1);
    expect(readFileSync(join(scratch, 'packages/myco/plugin-version.json'), 'utf8')).toBe(metadata);
    const manifestPath = join(scratch, 'plugins/myco/.claude-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.0.0-dev';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(generate(true).status).toBe(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

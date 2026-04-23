/**
 * Smoke harness for the 0.22.0 update apply flow.
 *
 * Exercises `generateUpdateScript` with the exact params produced by
 * `handleUpdateApply` across four scenarios. Prints the resulting shell
 * script for each case so the decision logic can be eyeballed without
 * cutting a real release or mutating the dev machine's npm install.
 *
 * Not a test — it hits the real `generateUpdateScript`, not a mock. Run
 * with: `bun scripts/smoke-update-flow.ts`
 *
 * Scenarios:
 *   1. Normal update on stable — user on 1.0.0, latest 1.1.0, machine-scoped
 *   2. Stable → Beta opt-in, version gap — user on 1.0.0, latest beta 1.1.0-beta.1
 *   3. Stable → Beta opt-in, matching global — user on 1.1.0, latest beta 1.1.0-beta.1
 *      (this is the case that used to silently 400 before the beta opt-in fix)
 *   4. Beta → Stable revert — user on 1.1.0-beta.1, stable 1.1.0, runtime-scoped
 */

import { generateUpdateScript } from '../packages/myco/src/daemon/update-installer.js';
import type { PackageCheckResult, CheckResult } from '../packages/myco/src/daemon/update-checker.js';
import { NPM_PACKAGE_NAME } from '../packages/myco/src/constants/update.js';

type RuntimeScope = 'project' | 'machine';

interface Scenario {
  label: string;
  description: string;
  status: CheckResult;
  runtimeScope: RuntimeScope;
  mycoBinary: string;
}

// Mirror of the decision logic in `handleUpdateApply`. Kept in sync by hand —
// the apply handler test suite verifies the same cases against the real
// handler; this harness exists for human inspection of the generated bash.
interface ApplyPlan {
  updateSpecs: string[];
  localRuntimeSpec: string | undefined;
  removeLocalRuntime: boolean;
  globalPackageSpecs: string[];
}

function computeApplyPlan(status: CheckResult, runtimeScope: RuntimeScope): ApplyPlan {
  const mycoPackage = status.packages.find((p) => p.id === 'myco');
  const mycoPackageSpec = mycoPackage?.latest_version
    ? `${mycoPackage.package_name}@${mycoPackage.latest_version}`
    : undefined;

  const updateSpecs = status.packages
    .filter((p) => p.installed && (p.update_available || p.revert_available) && p.latest_version)
    .map((p) => `${p.package_name}@${p.latest_version}`);

  const removeLocalRuntime = status.channel === 'stable' && runtimeScope === 'project';
  const enteringBetaLocalRuntime = status.channel === 'beta' && runtimeScope === 'machine';

  const localRuntimeSpec = enteringBetaLocalRuntime
    ? mycoPackageSpec
    : status.channel === 'beta'
      ? updateSpecs.find((s) => s.startsWith(`${NPM_PACKAGE_NAME}@`))
      : undefined;

  const globalPackageSpecs = localRuntimeSpec
    ? updateSpecs.filter((s) => s !== localRuntimeSpec)
    : updateSpecs;

  return { updateSpecs, localRuntimeSpec, removeLocalRuntime, globalPackageSpecs };
}

function makeMycoPackage(overrides: Partial<PackageCheckResult> = {}): PackageCheckResult {
  return {
    id: 'myco',
    display_name: 'Myco',
    package_name: NPM_PACKAGE_NAME,
    installed: true,
    installed_version: '1.0.0',
    latest_version: '1.1.0',
    latest_stable: '1.1.0',
    latest_beta: null,
    update_available: true,
    revert_available: false,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    update_available: true,
    revert_available: false,
    running_version: '1.0.0',
    latest_version: '1.1.0',
    latest_stable: '1.1.0',
    latest_beta: null,
    channel: 'stable',
    channel_scope: 'project',
    runtime_scope: 'machine',
    check_interval_hours: 6,
    last_check: new Date().toISOString(),
    error: null,
    packages: [makeMycoPackage()],
    ...overrides,
  };
}

const scenarios: Scenario[] = [
  {
    label: '1. Normal update on stable (machine-scoped)',
    description:
      'User on 1.0.0, latest stable 1.1.0. Expect: global npm install only; no project-local runtime, no removal.',
    status: makeStatus(),
    runtimeScope: 'machine',
    mycoBinary: 'myco',
  },
  {
    label: '2. Stable → Beta opt-in, version gap',
    description:
      'User on 1.0.0 global stable, latest beta 1.1.0-beta.1. Expect: project-local runtime install at beta; no global install.',
    status: makeStatus({
      channel: 'beta',
      latest_version: '1.1.0-beta.1',
      latest_stable: '1.0.0',
      latest_beta: '1.1.0-beta.1',
      packages: [
        makeMycoPackage({
          installed_version: '1.0.0',
          latest_version: '1.1.0-beta.1',
          latest_stable: '1.0.0',
          latest_beta: '1.1.0-beta.1',
        }),
      ],
    }),
    runtimeScope: 'machine',
    mycoBinary: 'myco',
  },
  {
    label: '3. Stable → Beta opt-in, matching global (the fixed case)',
    description:
      'User on 1.1.0 global stable; latest beta also 1.1.0 (e.g., stable caught up). Before the fix this returned 400; now expect: project-local runtime install at 1.1.0; no global install.',
    status: makeStatus({
      channel: 'beta',
      update_available: false,
      revert_available: false,
      running_version: '1.1.0',
      latest_version: '1.1.0',
      packages: [
        makeMycoPackage({
          installed_version: '1.1.0',
          latest_version: '1.1.0',
          update_available: false,
          revert_available: false,
        }),
      ],
    }),
    runtimeScope: 'machine',
    mycoBinary: 'myco',
  },
  {
    label: '4. Beta → Stable revert (project-scoped)',
    description:
      'User on 1.1.0-beta.1 via project-local runtime; latest stable 1.0.0. Expect: global install at stable (revert_available=true path) + remove local runtime.',
    status: makeStatus({
      channel: 'stable',
      update_available: false,
      revert_available: true,
      running_version: '1.1.0-beta.1',
      latest_version: '1.0.0',
      latest_stable: '1.0.0',
      latest_beta: '1.1.0-beta.1',
      packages: [
        makeMycoPackage({
          installed_version: '1.1.0-beta.1',
          latest_version: '1.0.0',
          latest_stable: '1.0.0',
          latest_beta: '1.1.0-beta.1',
          update_available: false,
          revert_available: true,
        }),
      ],
    }),
    runtimeScope: 'project',
    mycoBinary: '/project/.myco/runtime/node_modules/.bin/myco',
  },
];

const projectRoot = '/example/project';
const vaultDir = '/example/project/.myco';

function renderScenario(s: Scenario): void {
  console.log('═'.repeat(78));
  console.log(s.label);
  console.log('─'.repeat(78));
  console.log(s.description);
  console.log();

  const plan = computeApplyPlan(s.status, s.runtimeScope);
  console.log('Apply plan:');
  console.log(`  globalPackageSpecs:  ${JSON.stringify(plan.globalPackageSpecs)}`);
  console.log(`  localRuntimeSpec:    ${JSON.stringify(plan.localRuntimeSpec ?? null)}`);
  console.log(`  removeLocalRuntime:  ${plan.removeLocalRuntime}`);
  console.log();

  if (
    plan.globalPackageSpecs.length === 0 &&
    plan.localRuntimeSpec === undefined &&
    !plan.removeLocalRuntime
  ) {
    console.log('↪ Apply would return 400 no_update_available (no action computed).\n');
    return;
  }

  const script = generateUpdateScript({
    packageSpecs: plan.globalPackageSpecs,
    localRuntimeSpec: plan.localRuntimeSpec,
    removeLocalRuntime: plan.removeLocalRuntime,
    projectRoot,
    vaultDir,
    mycoBinary: s.mycoBinary,
  });

  console.log('Generated shell script:');
  console.log(
    script
      .split('\n')
      .map((line) => `  │ ${line}`)
      .join('\n'),
  );
  console.log();
}

console.log();
console.log('Myco update-apply smoke harness');
console.log(`vaultDir=${vaultDir}`);
console.log(`projectRoot=${projectRoot}`);
console.log();

for (const s of scenarios) {
  renderScenario(s);
}

console.log('═'.repeat(78));
console.log('Smoke complete. Compare each plan against the scenario description.');

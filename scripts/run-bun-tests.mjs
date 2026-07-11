#!/usr/bin/env node
// Drives `bun test` in two passes: non-tsx tests (pure Node environment) and
// tsx tests (jsdom via a dedicated bunfig). Honors MYCO_TEST_PROFILE=fast |
// integration to match the former vitest-side configuration.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic MYCO_HOME
// ---------------------------------------------------------------------------
// Tests must never touch the real ~/.myco. An unsandboxed write to
// ~/.myco/service/daemon.json points every capture hook on the machine at a
// dead port, and the hooks' capture-critical recovery then restarts the
// production daemon. Every test process spawned by this runner inherits a
// per-run sandbox home instead. An explicitly-set MYCO_HOME is honored so a
// debugging run can still target a fixture home.
if (!process.env.MYCO_HOME) {
  const sandboxMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-home-'));
  process.env.MYCO_HOME = sandboxMycoHome;
  process.on('exit', () => {
    try { fs.rmSync(sandboxMycoHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

// ---------------------------------------------------------------------------
// Hermetic team-home migration scan
// ---------------------------------------------------------------------------
// initTeamSync() runs the team-home migration, which by default sweeps the
// real ~/.myco and ~/.myco-dev (it must, in production). A test that boots
// initTeamSync would otherwise copy + RETIRE the developer's real
// ~/.myco/teams. Neutralise the default scan for the whole run; tests that
// exercise the migration pass explicit legacyHomes. An explicit value is
// honored so a debugging run can target fixture homes.
if (process.env.MYCO_TEAM_LEGACY_HOMES === undefined) {
  process.env.MYCO_TEAM_LEGACY_HOMES = '';
}

// ---------------------------------------------------------------------------
// Hermetic team home (~/.myco-team)
// ---------------------------------------------------------------------------
// The Team Host routing chokepoint reads the machine-global host/attach
// registry (~/.myco-team/hosts) on the daemon's inbound path, so any daemon
// test now transitively reads the developer's real team home. Same hazard
// class as the MYCO_HOME sandbox above — point every test process at a
// per-run sandbox instead. An explicit value is honored so a debugging run
// can target a fixture team home (the registry/routing tests set it per-test).
if (!process.env.MYCO_TEAM_HOME) {
  const sandboxTeamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-team-home-'));
  process.env.MYCO_TEAM_HOME = sandboxTeamHome;
  process.on('exit', () => {
    try { fs.rmSync(sandboxTeamHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

// ---------------------------------------------------------------------------
// Watchdog diagnostics
// ---------------------------------------------------------------------------
// Hangs in CI used to be opaque: the runner emitted a single
// `=== bun test (label) ===` line at phase start and then sat silent until
// either the subprocess exited or GitHub Actions killed the job. Recovering
// "which test was running when it hung" meant scrolling through thousands
// of log lines, often impossible mid-run.
//
// These constants drive a per-phase quiet-line detector. Every `INTERVAL`
// ms the runner checks how long it's been since the subprocess last wrote
// a non-empty line. If that quiet window exceeds `QUIET_MS`, the runner
// emits a structured `[run-bun-tests] STILL RUNNING …` line with the
// elapsed time AND the last non-empty line the subprocess produced —
// which is usually the test name Bun was about to or just started running.
// That single grepable line is enough to identify the hanger without
// re-reading the full log.
//
// Override via env vars to tighten/relax for local debugging:
//   MYCO_RUNNER_QUIET_MS — quiet threshold before a heartbeat is emitted
//   MYCO_RUNNER_HEARTBEAT_INTERVAL_MS — how often to check
const WATCHDOG_QUIET_MS = Number(process.env.MYCO_RUNNER_QUIET_MS ?? 30000);
const WATCHDOG_INTERVAL_MS = Number(process.env.MYCO_RUNNER_HEARTBEAT_INTERVAL_MS ?? 10000);

// Hard phase-kill deadline. The heartbeat above only *logs* a quiet phase; a
// genuinely wedged phase (a rare bun `--isolate` runtime spin — CPU-bound,
// synchronous, with no pending await for a test-side timeout to abort, leaving
// orphaned isolate workers holding test ports) would otherwise sit silent
// until the CI job-level timeout kills the whole job 10+ minutes later. When a
// phase produces NO output for `PHASE_KILL_QUIET_MS`, the runner kills the
// child's entire process group (bash + bun + every isolate worker) and fails
// the phase fast and visibly. This is defense-in-depth: the test-side
// ephemeral-port isolation prevents the collision that triggers most wedges;
// this guarantees that any wedge that slips through fails loudly instead of
// hanging. Generous by default so a slow-but-progressing phase is never
// killed; tune down for local debugging via the env override.
const PHASE_KILL_QUIET_MS = Number(process.env.MYCO_RUNNER_PHASE_KILL_QUIET_MS ?? 180000);

// How many times to re-run a phase that was killed for being wedged. A
// wedge-kill is provably not an assertion failure (no test output, killed by
// the quiet-deadline), and leaves no orphan, so a bounded retry turns the
// non-deterministic bun `--isolate` spin into a reliable green run instead of
// a suite failure. Set to 0 to disable (a wedge then fails the suite at 124).
const WEDGE_RETRIES = Number(process.env.MYCO_RUNNER_WEDGE_RETRIES ?? 3);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAST_EXCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];
const INTEGRATION_INCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];

const profile = process.env.MYCO_TEST_PROFILE ?? '';
const forwardedArgs = process.argv.slice(2);
// Isolated files are bundled into chunks to amortize bun's `--isolate`
// startup cost. Capped at 4 (was 8): the bun 1.3.14 `--isolate` runtime spin
// emerges from the multi-file isolate/SQLite-teardown churn, and an 8-file
// chunk of SQLite-heavy tests triggers it reliably under load. Three-file
// groups are the verified-clean default; the phase-kill + wedge-retry above
// remain the safety net for any chunk that still spins. Env-tunable for CI.
const ISOLATED_NODE_CHUNK_SIZE = Number(process.env.MYCO_RUNNER_ISOLATED_CHUNK_SIZE ?? 3);

// Bun's `--isolate` mode pays a large per-file startup cost. These groups
// have been validated to run correctly when imported through one generated
// bundle file, while unlisted groups keep per-file isolation.
const SAFE_NODE_BUNDLE_GROUPS = new Set([
  'tests/agent/tasks',
  'tests/backup',
  'tests/canopy',
  'tests/canopy/aggregate',
  'tests/canopy/describe',
  'tests/canopy/inject',
  'tests/canopy/map',
  'tests/canopy/parsers',
  'tests/canopy/scanner',
  'tests/capture',
  'tests/cli/providers',
  'tests/collective',
  'tests/config',
  'tests/constants',
  'tests/context',
  'tests/daemon/config-reactions',
  'tests/daemon/database',
  'tests/daemon/embedding',
  'tests/daemon/jobs',
  'tests/db/queries',
  'tests/deploy',
  'tests/embedding',
  'tests/grove',
  'tests/intelligence',
  'tests/logs',
  'tests/mcp',
  'tests/mcp/tools',
  'tests/myco-shared',
  'tests/notifications',
  'tests/plans',
  'tests/prompts',
  'tests/release-provenance',
  'tests/service',
  'tests/services',
  // 'tests/symbionts' intentionally omitted: installer.test.ts, installer-integration.test.ts,
  // installer-scope.test.ts, installer-invariants.test.ts and others all mutate process.env.HOME
  // and process.env.MYCO_HOME in beforeEach/afterEach. Under bun's default max-concurrency=20,
  // tests from different files can interleave within one shared bun process, creating a race on
  // process.env that produces ~93 spurious failures in the full suite (while passing in isolation
  // or in the scoped `npm test -- tests/symbionts/` run which uses --isolate per file). Each file
  // runs isolated below instead.
  'tests/symbionts/parsers',
  'tests/symbionts/templates',
  'tests/templates',
  'tests/tools',
  'tests/ui',
  'tests/ui/layout',
  'tests/utils',
  'tests/vault',
  'tests/worker',
  'tests/worker/integration',
  'tests/worker/mcp',
]);

// These targets pass as their own shared-process Bun run without `--isolate`.
// They are the first-class speed path: one process per clean domain, while
// leak-prone domains keep per-file isolation below.
const NO_ISOLATE_NODE_TARGETS = [
  'tests/agent/tasks',
  'tests/canopy',
  'tests/capture',
  'tests/cli/providers',
  'tests/collective',
  'tests/config',
  'tests/constants',
  'tests/context',
  'tests/daemon/config-reactions',
  'tests/daemon/database',
  'tests/daemon/embedding',
  'tests/daemon/jobs',
  'tests/db',
  // tests/deploy intentionally omitted: shared.test.ts calls mock.module().
  // The bundle path keeps the rest of the directory amortized while
  // shared.test.ts runs from SOLO_NODE_FILES.
  'tests/embedding',
  'tests/grove',
  'tests/intelligence',
  'tests/logs',
  'tests/mcp',
  'tests/myco-shared',
  'tests/notifications',
  'tests/plans',
  'tests/prompts',
  'tests/release-provenance',
  'tests/service',
  'tests/services',
  // 'tests/symbionts' intentionally omitted: see SAFE_NODE_BUNDLE_GROUPS comment above.
  // Root-level symbiont tests run per-file isolated to prevent process.env race conditions.
  'tests/templates',
  'tests/tools',
  'tests/ui/layout',
  'tests/utils',
  'tests/vault',
  'tests/worker',
  'tests/semantic-search-filters.test.ts',
  // tests/hooks intentionally omitted: response-shape tests depend on
  // process-global manifest capability state and have failed under Linux
  // shared Bun after neighboring hook fixtures mutate globals.
];

// Files that call mock.module() and therefore cannot share a bun process
// (the mock swaps the process-wide module registry), evicted from the
// shared groups below. They do NOT go to the --isolate chunks either:
// these are SQLite/daemon-server-heavy fixtures, the exact churn profile
// that triggers the bun 1.3.14 --isolate runtime spin (180s phase-kill ×
// retries). Each runs as its own plain single-file bun process instead —
// process-level isolation at ordinary startup cost.
const SOLO_NODE_FILES = [
  'tests/agent/phase-loop.test.ts',
  'tests/agent/tools-dry-run.test.ts',
  'tests/agent/tools-skills.test.ts',
  'tests/daemon/api/agent-runs-overrides-security.test.ts',
  'tests/daemon/api/cortex.test.ts',
  'tests/daemon/api/key-leak-guard.test.ts',
  'tests/daemon/api/providers-ssrf.test.ts',
  'tests/daemon/api/restart.test.ts',
  'tests/daemon/api/stats.test.ts',
  // These dispatcher fixtures share the ambient test DB and dispatcher
  // lifecycle heavily enough that they stay cheaper and less flaky as
  // explicit single-file processes than as hidden source-pattern matches.
  'tests/daemon/event-contract-recovery.test.ts',
  'tests/daemon/event-dispatch.test.ts',
  'tests/daemon/team-sync.test.ts',
  'tests/deploy/shared.test.ts',
];

const SOLO_NODE_REASON_LISTED_FILE = 'listed-solo-node-file';
const SOLO_NODE_REASON_MODULE_MOCK = 'mock.module';

const NO_ISOLATE_NODE_GROUPS = [
  {
    label: 'tests-agent-stable',
    targets: [
      'tests/agent/claude-code-executable.test.ts',
      'tests/agent/context-queries.test.ts',
      'tests/agent/lmstudio-context.test.ts',
      'tests/agent/map-phase.test.ts',
      'tests/agent/ollama-context.test.ts',
      'tests/agent/openai-runtime.test.ts',
      'tests/agent/openrouter-catalog.test.ts',
      'tests/agent/orchestrator.test.ts',
      'tests/agent/provider-harness.test.ts',
      'tests/agent/provider.test.ts',
      'tests/agent/run-accounting.test.ts',
      'tests/agent/schemas.test.ts',
      'tests/agent/skill-candidate-evidence.test.ts',
      'tests/agent/skill-candidate-quality.test.ts',
      'tests/agent/skill-drift.test.ts',
      'tests/agent/skill-staging.test.ts',
      'tests/agent/tools/canopy-tools.test.ts',
      // runtime-claude.test.ts, phase-loop.test.ts, and tools-dry-run.test.ts
      // intentionally omitted: they call mock.module(), which is
      // process-global and poisons later files in a shared run (phase-loop's
      // request-context mock erased scope filtering in context-queries on
      // Linux orderings). assertNoModuleMocksInSharedFiles enforces this.
    ],
  },
  {
    label: 'tests-daemon-root-stable',
    targets: [
      'tests/daemon/backup-multiline.test.ts',
      'tests/daemon/capture-images.test.ts',
      'tests/daemon/codex-plan-capture.test.ts',
      'tests/daemon/git-status.test.ts',
      'tests/daemon/handle-user-prompt-steering.test.ts',
      'tests/daemon/inflight-runs.test.ts',
      'tests/daemon/lifecycle.test.ts',
      'tests/daemon/migration-tasks.test.ts',
      'tests/daemon/plan-capture.test.ts',
      'tests/daemon/plan-watch-reaction.test.ts',
      'tests/daemon/port.test.ts',
      'tests/daemon/power.test.ts',
      'tests/daemon/project-power-state.test.ts',
      'tests/daemon/reconciliation-cache-poisoning.test.ts',
      'tests/daemon/reconciliation-dedup.test.ts',
      'tests/daemon/router.test.ts',
      'tests/daemon/skill-usage-detection.test.ts',
      'tests/daemon/stale-session-sweep.test.ts',
      'tests/daemon/static.test.ts',
      'tests/daemon/stop-processing.test.ts',
      'tests/daemon/task-scheduler.test.ts',
      'tests/daemon/team-members-handler.test.ts',
      'tests/daemon/update-in-progress-sentinel.test.ts',
      'tests/daemon/update-installer.test.ts',
      // machine-id.test.ts tests the real getMachineId() implementation and
      // must NOT share a process with team-sync.test.ts, which mocks the
      // entire @myco/daemon/machine-id.js module. Kept here where no such
      // mock exists.
      'tests/daemon/machine-id.test.ts',
      'tests/daemon/subsystem-claim.test.ts',
      // tests/daemon/event-loop-lag.test.ts intentionally omitted: it uses
      // real timers plus synchronous loop blocking. In the Linux shared Bun
      // daemon-root phase, earlier timer-heavy daemon tests can leave enough
      // scheduler state behind that this fixture stalls despite passing
      // standalone. Running it isolated keeps the probe timing contract local.
    ],
  },
  {
    label: 'tests-daemon-api-stable',
    targets: [
      'tests/daemon/api/action-inflight.test.ts',
      'tests/daemon/api/action-scope.test.ts',
      'tests/daemon/api/agent-tasks.test.ts',
      'tests/daemon/api/backup-config-grove-tier.test.ts',
      'tests/daemon/api/backup-liveconfig.test.ts',
      'tests/daemon/api/canopy-entries-api.test.ts',
      'tests/daemon/api/canopy-map-api.test.ts',
      'tests/daemon/api/config-cortex-paths.test.ts',
      'tests/daemon/api/config.test.ts',
      'tests/daemon/api/context.test.ts',
      'tests/daemon/api/database-scope.test.ts',
      'tests/daemon/api/database.test.ts',
      'tests/daemon/api/digest-revisions.test.ts',
      'tests/daemon/api/embedding-ops.test.ts',
      'tests/daemon/api/groves-crud.test.ts',
      'tests/daemon/api/groves.test.ts',
      'tests/daemon/api/log-explorer.test.ts',
      'tests/daemon/api/maintenance.test.ts',
      'tests/daemon/api/models.test.ts',
      'tests/daemon/api/mycelium.test.ts',
      'tests/daemon/api/pause-enforcement.test.ts',
      'tests/daemon/api/progress.test.ts',
      'tests/daemon/api/projects-activity.test.ts',
      'tests/daemon/api/projects-backup-restore.test.ts',
      'tests/daemon/api/provider-secrets.test.ts',
      'tests/daemon/api/run-serializer.test.ts',
      'tests/daemon/api/schemas/execution-overrides-traversal.test.ts',
      'tests/daemon/api/search-canopy.test.ts',
      'tests/daemon/api/search-normalization.test.ts',
      'tests/daemon/api/search-team.test.ts',
      'tests/daemon/api/sessions.test.ts',
      'tests/daemon/api/skills-delete.test.ts',
      'tests/daemon/api/skills.test.ts',
      'tests/daemon/api/spores-session-filter.test.ts',
      'tests/daemon/api/spores.test.ts',
      'tests/daemon/api/team-connect-handlers.test.ts',
      'tests/daemon/api/team-connect-status.test.ts',
      'tests/daemon/api/team-upgrade-worker.test.ts',
      // tests/daemon/api/update.test.ts intentionally omitted — its top-level
      // `mock.module('@myco/daemon/update-checker.js', ...)` is hoisted by bun
      // ahead of the `await import(...)` that tries to capture the real module
      // for afterAll restoration, so the stub leaks for the rest of the bun
      // process. Mock state from later tests (e.g. `getInstalledVersion`
      // returning '1.1.0') then poisons the team-connect-status status test
      // that depends on the real reader. Running it isolated keeps the
      // mock-induced leak contained to its own bun process.
    ],
  },
  // tests-agent-tools-core intentionally omitted: these files pass
  // standalone, but context/loader/registry/tool-surface tests mutate
  // process-global agent/tool/resource state that can leak across one
  // Linux shared Bun process.
  {
    label: 'tests-agent-skill-tools',
    targets: [
      'tests/agent/tools/vault-search-canopy.test.ts',
    ],
  },
  {
    label: 'tests-daemon-service-boundary',
    targets: [
      'tests/daemon/reconciliation-stop.test.ts',
      'tests/daemon/reconcile-existing-daemon.test.ts',
      'tests/daemon/grove-runtime-cache.test.ts',
      'tests/daemon/eviction.test.ts',
      'tests/daemon/server-security.test.ts',
      'tests/daemon/grove-ownership-boundary.test.ts',
      'tests/daemon/legacy-scope-removed.test.ts',
      'tests/daemon/data-paths.test.ts',
      'tests/daemon/http-server-limits.test.ts',
      'tests/daemon/logger.test.ts',
      'tests/daemon/state-file-invariant.test.ts',
    ],
  },
  {
    label: 'tests-daemon-capture-backup',
    targets: [
      'tests/daemon/backup-canopy-roundtrip.test.ts',
      'tests/daemon/capture.test.ts',
      'tests/daemon/backup.test.ts',
    ],
  },
  {
    label: 'tests-daemon-power-sweeps',
    targets: [
      'tests/daemon/power-jobs.test.ts',
      'tests/daemon/scope-iteration.test.ts',
      'tests/daemon/cold-project-gate.test.ts',
      'tests/daemon/tick-paths-pause.test.ts',
      'tests/daemon/scheduler-pause.test.ts',
      'tests/daemon/self-reconcile.test.ts',
    ],
  },
  {
    label: 'tests-daemon-lifecycle-leftovers',
    targets: [
      'tests/daemon/startup-pauses.test.ts',
      'tests/daemon/intent.test.ts',
      'tests/daemon/agent-loop-responsiveness.test.ts',
      'tests/daemon/lifecycle-lock-startup.test.ts',
      'tests/daemon/trigger-title-summary.test.ts',
    ],
  },
];

const VALUE_FLAGS = new Set([
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--rerun-each',
  '--retry',
  '--bail',
  '--coverage-reporter',
  '--coverage-dir',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--parallel',
  '--parallel-delay',
  '--shard',
]);

function parseForwardedArgs(args) {
  const options = [];
  const targets = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      options.push(arg);
      const flag = arg.split('=')[0];
      if (!arg.includes('=') && VALUE_FLAGS.has(flag) && i + 1 < args.length) {
        options.push(args[i + 1]);
        i += 1;
      }
    } else {
      targets.push(arg);
    }
  }

  return { options, targets };
}

function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function findTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, out);
    else if (entry.isFile() && isTestFile(entry.name)) out.push(full);
  }
  return out;
}

function findTsxTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTsxTests(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

function relativeUnique(files) {
  return [...new Set(files.map((f) => path.relative(REPO, f)))].sort();
}

function isFastExcluded(file) {
  return FAST_EXCLUDES.some((excluded) => {
    if (file === excluded) return true;
    return excluded.endsWith('/') && file.startsWith(excluded);
  });
}

function groupKeyForTestFile(file) {
  const parts = file.split('/');
  if (parts.length <= 2) return 'tests/root';
  return parts.slice(0, Math.min(3, parts.length - 1)).join('/');
}

function bundleSlug(key) {
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

function writeNodeBundleTargets(files) {
  if (process.env.MYCO_TEST_BUNDLE_NODE === '0') {
    return files;
  }

  const groups = new Map();
  const isolated = [];

  for (const file of files) {
    const key = groupKeyForTestFile(file);
    // mock.module() files never bundle: a bundle concatenates sources into
    // one file, so --isolate cannot contain the process-global mock.
    if (!SAFE_NODE_BUNDLE_GROUPS.has(key) || fileHasModuleMock(file)) {
      isolated.push(file);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  const bundleDir = path.join(REPO, 'target', 'test-bundles', 'node-env');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  const bundledTargets = [];
  let bundledFileCount = 0;

  for (const [key, groupFiles] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (groupFiles.length < 2) {
      isolated.push(...groupFiles);
      continue;
    }

    bundledFileCount += groupFiles.length;
    const relativeBundle = path.join('target', 'test-bundles', 'node-env', `${bundleSlug(key)}.test.ts`);
    const absoluteBundle = path.join(REPO, relativeBundle);
    const imports = groupFiles
      .sort()
      .map((file) => `import '../../../${file}';`)
      .join('\n');
    fs.writeFileSync(absoluteBundle, `${imports}\n`);
    bundledTargets.push(relativeBundle);
  }

  if (bundledTargets.length > 0) {
    console.log(
      `[run-bun-tests] bundled node env: ${bundledFileCount} files -> ${bundledTargets.length} bundles; ${isolated.length} files stay isolated`,
    );
  }

  return [...bundledTargets.sort(), ...isolated.sort()];
}

// bun's mock.module() swaps a module in the PROCESS-WIDE registry. In a
// shared (no --isolate) phase the mock persists into every file that runs
// after it — bun's file order is platform-dependent, so the poisoning
// surfaces as a CI-only flake (e.g. a mocked projectScopeFromRequestContext
// erasing scope filtering for a later tenancy test). Inside a generated
// bundle file, --isolate can't separate the concatenated sources either.
// Files that call mock.module() must run with per-file isolation; the
// checks below enforce that instead of trusting the hand-maintained
// group lists.
const moduleMockCache = new Map();
function fileHasModuleMock(file) {
  if (!moduleMockCache.has(file)) {
    let hasMock = false;
    try {
      hasMock = /\bmock\.module\(/.test(fs.readFileSync(path.resolve(REPO, file), 'utf-8'));
    } catch { /* unreadable file — let bun surface it */ }
    moduleMockCache.set(file, hasMock);
  }
  return moduleMockCache.get(file);
}

function soloNodeProcessReason(file) {
  if (fileHasModuleMock(file)) return SOLO_NODE_REASON_MODULE_MOCK;
  return null;
}

function fileRequiresSoloNodeProcess(file) {
  return soloNodeProcessReason(file) !== null;
}

function listedSoloNodeReason(file) {
  return soloNodeProcessReason(file) ?? SOLO_NODE_REASON_LISTED_FILE;
}

function formatSoloNodeReasonSummary(files) {
  const reasonCounts = new Map();
  for (const file of files) {
    const reason = listedSoloNodeReason(file);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  return [...reasonCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
}

function assertNoModuleMocksInSharedFiles(sharedFiles) {
  const offenders = sharedFiles.filter(fileHasModuleMock);
  if (offenders.length === 0) return;
  console.error(
    '[run-bun-tests] FATAL: these files call mock.module() but are routed to a shared (no --isolate) phase:',
  );
  for (const file of offenders) console.error(`  - ${file}`);
  console.error(
    '[run-bun-tests] mock.module() leaks across files in a shared bun process. '
    + 'Remove the file from NO_ISOLATE_NODE_TARGETS / NO_ISOLATE_NODE_GROUPS so it runs in the isolated phase.',
  );
  process.exit(1);
}

function targetCoversFile(target, file) {
  if (file === target) return true;
  return !target.endsWith('.ts') && file.startsWith(`${target}/`);
}

function isCoveredByNoIsolateTarget(file) {
  return NO_ISOLATE_NODE_TARGETS.some((target) => targetCoversFile(target, file))
    || NO_ISOLATE_NODE_GROUPS.some((group) => group.targets.some((target) => targetCoversFile(target, file)));
}

function targetHasFiles(target, files) {
  return files.some((file) => targetCoversFile(target, file));
}

function groupHasFiles(group, files) {
  return group.targets.some((target) => targetHasFiles(target, files));
}

function noIsolateArgsForTarget(target, options) {
  return [
    ...options,
    target,
    "--path-ignore-patterns=**/*.test.tsx",
    ...(profile === 'fast' ? fastIgnoreArgs() : []),
  ];
}

function noIsolateArgsForFiles(files, options) {
  return [
    ...options,
    ...files,
    "--path-ignore-patterns=**/*.test.tsx",
    ...(profile === 'fast' ? fastIgnoreArgs() : []),
  ];
}

function noIsolatePhaseForTarget(target, options) {
  return {
    label: `node env shared ${bundleSlug(target)}`,
    args: noIsolateArgsForTarget(target, options),
    isolate: false,
  };
}

// Emit the files the group actually covers within `sharedFiles` rather than the
// literal target list. `group.targets` is a *selector*; `sharedFiles` has
// already excluded solo / process-sensitive files, so a file listed in both a
// group and SOLO_NODE_FILES can never leak back into a shared (no-isolate)
// process. Keeps the emitted set identical to the partition accounting.
function noIsolatePhaseForGroup(group, sharedFiles, options) {
  return {
    label: `node env shared ${group.label}`,
    args: noIsolateArgsForFiles(sharedGroupFiles(group, sharedFiles), options),
    isolate: false,
  };
}

function soloNodePhaseForFile(file, options) {
  return {
    label: `node env solo ${bundleSlug(file.replace(/^tests\//, '').replace(/\.test\.ts$/, ''))}`,
    args: [...options, file, "--path-ignore-patterns=**/*.test.tsx"],
    isolate: false,
  };
}

function sharedTargetFiles(target, files) {
  return files.filter((file) => targetCoversFile(target, file));
}

function sharedGroupFiles(group, files) {
  return files.filter((file) => group.targets.some((target) => targetCoversFile(target, file)));
}

function sharedFileCount(targets, groups, files) {
  const covered = new Set();
  for (const target of targets) {
    for (const file of sharedTargetFiles(target, files)) covered.add(file);
  }
  for (const group of groups) {
    for (const file of sharedGroupFiles(group, files)) covered.add(file);
  }
  return covered.size;
}

function findSharedTargets(files) {
  return NO_ISOLATE_NODE_TARGETS.filter((target) => targetHasFiles(target, files));
}

function findSharedGroups(files) {
  return NO_ISOLATE_NODE_GROUPS.filter((group) => groupHasFiles(group, files));
}

function buildNoIsolatePhases(targets, groups, sharedFiles, options) {
  return [
    ...targets.map((target) => noIsolatePhaseForTarget(target, options)),
    ...groups.map((group) => noIsolatePhaseForGroup(group, sharedFiles, options)),
  ];
}

function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildIsolatedNodePhases(targets, options) {
  if (targets.length === 0) return [];

  const chunks = chunkItems(targets, ISOLATED_NODE_CHUNK_SIZE);
  if (chunks.length > 1) {
    console.log(
      `[run-bun-tests] isolated node env: ${targets.length} targets across ${chunks.length} chunks`,
    );
  }

  return chunks.map((chunk, index) => ({
    label: chunks.length === 1 ? 'node env isolated' : `node env isolated ${index + 1}`,
    args: [...options, ...chunk],
    isolate: true,
  }));
}

function fastIgnoreArgs() {
  return FAST_EXCLUDES.map((p) => `--path-ignore-patterns=${p}**`);
}

function expandTargets(targets) {
  const nonDom = [];
  const dom = [];
  const passthrough = [];

  for (const target of targets) {
    const full = path.resolve(REPO, target);
    if (!fs.existsSync(full)) {
      passthrough.push(target);
      continue;
    }

    const stat = fs.statSync(full);
    const files = stat.isDirectory() ? findTests(full) : [full];
    for (const file of files) {
      if (file.endsWith('.test.tsx')) dom.push(file);
      else nonDom.push(file);
    }
  }

  return {
    nonDom: relativeUnique(nonDom),
    dom: relativeUnique(dom),
    passthrough,
  };
}

/**
 * Returns node-env phases plus optional DOM args. Whole-suite node runs are
 * split by isolation boundary; explicit target and integration runs stay in
 * one isolated node phase.
 */
function buildArgs() {
  const { options, targets } = parseForwardedArgs(forwardedArgs);
  const tsxFiles = relativeUnique(findTsxTests(path.join(REPO, 'tests')));

  if (targets.length > 0) {
    const expanded = expandTargets(targets);
    if (expanded.passthrough.length > 0) {
      console.warn(
        `[run-bun-tests] treating unmatched target(s) as Bun patterns: ${expanded.passthrough.join(', ')}`,
      );
    }

    const nonDomTargets = [...expanded.nonDom, ...expanded.passthrough];
    const soloTargets = nonDomTargets.filter((file) => fileRequiresSoloNodeProcess(file));
    const soloTargetSet = new Set(soloTargets);
    const isolatedTargets = nonDomTargets.filter((file) => !soloTargetSet.has(file));
    return {
      nonDomPhases: [
        ...soloTargets.map((file) => soloNodePhaseForFile(file, options)),
        ...(isolatedTargets.length > 0 ? [{
          label: 'node env',
          args: [...options, ...isolatedTargets, "--path-ignore-patterns=**/*.test.tsx"],
          isolate: true,
        }] : []),
      ],
      dom: expanded.dom.length > 0 ? [...options, ...expanded.dom] : null,
    };
  }

  if (profile !== 'integration') {
    const allTests = relativeUnique(findTests(path.join(REPO, 'tests')));
    const nonDomFiles = allTests
      .filter((file) => !file.endsWith('.test.tsx'))
      .filter((file) => profile !== 'fast' || !isFastExcluded(file));
    const soloFiles = relativeUnique([
      ...SOLO_NODE_FILES,
      ...nonDomFiles.filter(fileRequiresSoloNodeProcess),
    ]).filter((file) => nonDomFiles.includes(file));
    const soloFileSet = new Set(soloFiles);
    const sharedFiles = nonDomFiles.filter((file) => !soloFileSet.has(file) && isCoveredByNoIsolateTarget(file));
    const isolatedFiles = nonDomFiles.filter(
      (file) => !isCoveredByNoIsolateTarget(file) && !soloFileSet.has(file),
    );
    assertNoModuleMocksInSharedFiles(sharedFiles);

    const sharedTargets = findSharedTargets(sharedFiles);
    const sharedGroups = findSharedGroups(sharedFiles);

    const isolatedTargets = writeNodeBundleTargets(isolatedFiles);

    if (soloFiles.length > 0) {
      console.log(
        `[run-bun-tests] solo node env: ${soloFiles.length} process-sensitive files run as single-file processes (${formatSoloNodeReasonSummary(soloFiles)})`,
      );
    }

    if (sharedTargets.length > 0 || sharedGroups.length > 0) {
      const groupCount = sharedTargets.length + sharedGroups.length;
      const fileCount = sharedFileCount(sharedTargets, sharedGroups, sharedFiles);
      console.log(
        `[run-bun-tests] non-isolated node env: ${fileCount} files across ${groupCount} target groups`,
      );
    }

    return {
      nonDomPhases: [
        ...buildNoIsolatePhases(sharedTargets, sharedGroups, sharedFiles, options),
        ...soloFiles.map((file) => soloNodePhaseForFile(file, options)),
        ...buildIsolatedNodePhases(isolatedTargets, options),
      ],
      dom: tsxFiles.length > 0 ? [...options, ...tsxFiles] : null,
    };
  }

  if (profile === 'integration') {
    return {
      // Integration profile: tests/integration + tests/smoke plus a few
      // named files. None are tsx at time of writing.
      nonDomPhases: [{
        label: 'node env',
        args: [...options, ...INTEGRATION_INCLUDES, "--path-ignore-patterns=**/*.test.tsx"],
        isolate: true,
      }],
      dom: null,
    };
  }

  throw new Error(`Unknown test profile: ${profile}`);
}

// Where per-phase test artifacts land. Always written so that a non-zero exit
// can be followed up by reading a deterministic file — instead of grepping
// through the human-readable stream (which loses ANSI markers when piped and
// drowns failure lines under 4,900+ pass lines).
//
// Two artifacts per phase:
//   - <phase>.junit.xml — Bun's JUnit XML (captures assertion failures)
//   - <phase>.log       — verbatim tee of Bun's stdout+stderr (captures the
//                         "1 error" class that the JUnit reporter silently
//                         drops, plus context lines around `(fail)` markers)
const REPORT_DIR = path.join(REPO, 'target', 'test-reports');
function reportPath(label) {
  return path.join(REPORT_DIR, `${label.replace(/\s+/g, '-')}.junit.xml`);
}
function logPath(label) {
  return path.join(REPORT_DIR, `${label.replace(/\s+/g, '-')}.log`);
}

function resetReportDir() {
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

async function runPhase(label, extraArgs, bunfig, { isolate }) {
  if (extraArgs === null || extraArgs.length === 0) return 0;
  // `BUN_CONFIG_FILE` is not observed by `bun test` for the bunfig; the only
  // reliable way to swap configs is to move the file on disk for the
  // duration of the run.
  const canonical = path.join(REPO, 'bunfig.toml');
  const backup = path.join(REPO, '.bunfig.toml.runner-backup');
  let restored = false;
  if (bunfig && bunfig !== canonical) {
    if (fs.existsSync(canonical)) fs.renameSync(canonical, backup);
    fs.copyFileSync(bunfig, canonical);
    restored = true;
  }
  try {
    console.log(`\n=== bun test (${label}) ===`);
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportFile = reportPath(label);
    const teeFile = logPath(label);
    fs.writeFileSync(teeFile, ''); // start empty so re-runs don't append stale data
    // Always emit a JUnit XML report alongside the human-readable stream.
    // We tee stdout+stderr to both the terminal AND a local log file so a
    // post-run scan can recover the "1 error" class that Bun's JUnit
    // reporter drops (file-load errors, unhandled rejections, etc.).
    const args = [
      'test',
      ...(isolate ? ['--isolate'] : []),
      '--reporter=junit',
      `--reporter-outfile=${reportFile}`,
      ...extraArgs,
    ];
    // A wedge-kill (exit 124, no test output) is never a real assertion
    // failure — it's the synchronous bun `--isolate` runtime spin that this
    // workload triggers non-deterministically. Because the phase-kill leaves
    // no orphan to poison a re-run, retrying the wedged phase once recovers a
    // clean pass without masking any genuine failure (a real failure exits
    // with assertion output and `wedged:false`, so it is never retried).
    let { status, wedged } = await runWithTeeAndHeartbeat('bun', args, teeFile, label);
    for (let attempt = 1; wedged && attempt <= WEDGE_RETRIES; attempt += 1) {
      const note = `[run-bun-tests] RETRYING ${label} after wedge-kill (attempt ${attempt}/${WEDGE_RETRIES})\n`;
      process.stderr.write(note);
      fs.writeFileSync(teeFile, ''); // fresh log for the retry
      ({ status, wedged } = await runWithTeeAndHeartbeat('bun', args, teeFile, label));
    }
    return status;
  } finally {
    if (restored) {
      fs.rmSync(canonical, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, canonical);
    }
  }
}

/**
 * Parse a Bun-emitted JUnit XML and return a flat list of failures.
 *
 * Bun emits two `<testcase>` shapes:
 *   - self-closing: `<testcase name="…" classname="…" … />`        (pass)
 *   - paired:      `<testcase name="…" …><failure …/></testcase>`  (fail/skip)
 *
 * We must NOT match the self-closing form with a paired-tag regex — that
 * would greedily span from a passing testcase through to the next paired
 * `</testcase>` and report the wrong test as the failure. The lookbehind
 * `(?<!\/)` on the open-tag `>` excludes self-closers.
 *
 * `name` is the test (it block) name; `classname` is the describe-suite
 * path. `file` (a separate attribute Bun emits) is the source path —
 * useful for jumping to the failing file.
 */
function parseFailuresFromJunit(file) {
  if (!fs.existsSync(file)) return [];
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const failures = [];
  const pairedTestcasePattern =
    /<testcase\b([^>]*?)(?<!\/)\s*>([\s\S]*?)<\/testcase>/g;
  for (const match of xml.matchAll(pairedTestcasePattern)) {
    const attrs = match[1];
    const body = match[2];
    if (!/<failure\b/.test(body)) continue;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? '(unnamed)';
    const classname = attrs.match(/\bclassname="([^"]*)"/)?.[1] ?? '';
    const sourceFile = attrs.match(/\bfile="([^"]*)"/)?.[1] ?? '';
    const lineNo = attrs.match(/\bline="([^"]*)"/)?.[1] ?? '';
    // Bun's `<failure>` is usually `<failure type="AssertionError" />` with
    // no message attribute; the human-readable message is on stdout. We
    // still try to surface `message` and `type` when present.
    const failureMessage = body.match(/<failure[^>]*\bmessage="([^"]*)"/)?.[1] ?? '';
    const failureType = body.match(/<failure[^>]*\btype="([^"]*)"/)?.[1] ?? '';
    failures.push({
      name: decodeXmlEntities(name),
      classname: decodeXmlEntities(classname),
      file: sourceFile,
      line: lineNo,
      message: decodeXmlEntities(failureMessage || failureType),
    });
  }
  return failures;
}

/**
 * Run a subprocess synchronously while teeing stdout+stderr to both the
 * terminal (so live progress is preserved) and a log file (so a
 * post-run scanner can find failure context that the JUnit reporter
 * silently drops).
 *
 * Implemented with synchronous spawnSync + a child that writes to a pipe
 * to `tee` via shell — simplest cross-platform path that preserves exit
 * code without requiring Node's async event loop in this script.
 *
 * Explicit `/bin/bash` invocation: `set -o pipefail` is a bash-only
 * feature. Ubuntu CI runners ship dash as `/bin/sh`, which rejects it
 * with "Illegal option -o pipefail" and aborts before any tests run.
 * bash is reliably present on every CI runner and on macOS.
 */
function runWithTee(command, args, teeFile) {
  const escaped = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const teePath = teeFile.replace(/'/g, `'\\''`);
  const shellCmd = `set -o pipefail; ${command} ${escaped} 2>&1 | tee -a '${teePath}'`;
  const result = spawnSync('/bin/bash', ['-c', shellCmd], {
    cwd: REPO,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

/**
 * Async variant of `runWithTee` with a quiet-line watchdog. Pipes child
 * stdout/stderr through Node so we can:
 *   - tee to the terminal (preserves live progress in CI logs)
 *   - tee to the per-phase log file (preserves the existing artifact)
 *   - track the last non-empty line and timestamp
 *
 * Every `WATCHDOG_INTERVAL_MS` we check whether the child has produced
 * output recently. If `WATCHDOG_QUIET_MS` has passed since the last
 * non-empty line, we emit a heartbeat that includes that last line —
 * which is usually a Bun test name. This makes hangs grepable: after
 * the run, `grep STILL RUNNING <log>` points straight at the file/test
 * that was stuck.
 *
 * Behavior is otherwise identical to `runWithTee` — same shell command,
 * same pipefail handling, same exit-code semantics.
 */
async function runWithTeeAndHeartbeat(command, args, teeFile, label) {
  const escaped = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const shellCmd = `set -o pipefail; ${command} ${escaped}`;
  const startMs = Date.now();
  process.stderr.write(`[run-bun-tests] STARTING ${label}\n`);

  return new Promise((resolve) => {
    // `detached: true` puts the child in its own process group so a hard
    // phase-kill can signal the WHOLE tree (bash + bun + bun's isolate
    // workers) via the negative pid. Without this, killing only the bash
    // wrapper would leave the spinning bun worker (and the test ports it
    // holds) orphaned — the exact failure that poisons subsequent runs.
    const child = spawn('/bin/bash', ['-c', shellCmd], {
      cwd: REPO,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
    });

    let killedForHang = false;
    function killPhaseTree(signal) {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    }

    let lastNonEmptyLine = '';
    let lastOutputMs = Date.now();
    // Buffer partial lines across chunks so we attribute the last
    // non-empty line correctly even when chunks arrive mid-line.
    let stdoutTail = '';
    let stderrTail = '';

    function ingest(chunk, stream, tailRef) {
      const text = chunk.toString();
      // Mirror to terminal verbatim — preserves ANSI/formatting for
      // anyone watching the live log.
      stream.write(text);
      // Mirror to the log file. Sync append: chunks are small, sync
      // I/O here matches the prior runWithTee behavior (shell tee was
      // also sync per write).
      try { fs.appendFileSync(teeFile, text); } catch { /* best-effort */ }
      // Track the last non-empty line for the watchdog heartbeat.
      const combined = tailRef.value + text;
      const lines = combined.split(/\r?\n/);
      tailRef.value = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          lastNonEmptyLine = trimmed;
          lastOutputMs = Date.now();
        }
      }
    }
    const stdoutRef = { value: stdoutTail };
    const stderrRef = { value: stderrTail };
    child.stdout.on('data', (c) => ingest(c, process.stdout, stdoutRef));
    child.stderr.on('data', (c) => ingest(c, process.stderr, stderrRef));

    const watchdog = setInterval(() => {
      const sinceLastOutput = Date.now() - lastOutputMs;
      if (sinceLastOutput >= PHASE_KILL_QUIET_MS && !killedForHang) {
        killedForHang = true;
        const totalElapsed = Date.now() - startMs;
        const msg = `[run-bun-tests] WEDGED ${label} — no output for ${sinceLastOutput}ms (>${PHASE_KILL_QUIET_MS}ms), ${totalElapsed}ms elapsed; killing phase tree. Last line: ${lastNonEmptyLine || '(none)'}\n`;
        process.stderr.write(msg);
        try { fs.appendFileSync(teeFile, msg); } catch { /* best-effort */ }
        killPhaseTree('SIGTERM');
        // Escalate to SIGKILL shortly after, in case the tree ignores SIGTERM.
        setTimeout(() => killPhaseTree('SIGKILL'), 2000).unref?.();
        return;
      }
      if (sinceLastOutput >= WATCHDOG_QUIET_MS) {
        const totalElapsed = Date.now() - startMs;
        const msg = `[run-bun-tests] STILL RUNNING ${label} — ${totalElapsed}ms elapsed, ${sinceLastOutput}ms since last output; last line: ${lastNonEmptyLine || '(none)'}\n`;
        process.stderr.write(msg);
        try { fs.appendFileSync(teeFile, msg); } catch { /* best-effort */ }
      }
    }, WATCHDOG_INTERVAL_MS);
    // Don't keep the event loop alive purely for the heartbeat — the
    // child's pipes are the load-bearing references that hold the
    // process open.
    watchdog.unref?.();

    child.on('error', (err) => {
      clearInterval(watchdog);
      process.stderr.write(`[run-bun-tests] FAILED TO SPAWN ${label}: ${err?.message ?? err}\n`);
      resolve({ status: 1, wedged: false });
    });

    child.on('close', (code) => {
      clearInterval(watchdog);
      const totalMs = Date.now() - startMs;
      const tail = lastNonEmptyLine ? ` (last line: ${lastNonEmptyLine})` : '';
      const exit = killedForHang ? 124 : (code ?? 1);
      const verb = killedForHang ? 'KILLED (wedged)' : 'FINISHED';
      const completion = `[run-bun-tests] ${verb} ${label} in ${totalMs}ms (exit ${exit})${tail}\n`;
      process.stderr.write(completion);
      try { fs.appendFileSync(teeFile, completion); } catch { /* best-effort */ }
      resolve({ status: exit, wedged: killedForHang });
    });
  });
}

function decodeXmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

/**
 * Scan a phase's tee'd log for failure context that Bun's JUnit reporter
 * doesn't capture. Two patterns:
 *   1. `(fail) <test path>` — assertion failures (also in JUnit, but kept
 *      here as a cross-check).
 *   2. `error: <message>` followed by an `at <file>:<line>:<col>` stack
 *      frame — uncaught errors / unhandled rejections / file-load failures
 *      that Bun summarizes as `N error` but never emits as a `<failure>`
 *      node in the JUnit XML.
 */
function parseFailuresFromLog(file) {
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const failures = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // (fail) markers — Bun's stdout per-test failure announcement.
    const failMatch = line.match(/^\(fail\)\s+(.+?)(?:\s+\[[^\]]*\])?$/);
    if (failMatch) {
      failures.push({ kind: 'fail', name: failMatch[1].trim(), location: '' });
      continue;
    }
    // error: lines — typically followed by a stack frame within ~10 lines.
    const errMatch = line.match(/^error:\s+(.+)$/);
    if (errMatch) {
      let location = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const stackMatch = lines[j].match(/at\s+(?:<anonymous>\s+)?\((.+?:\d+(?::\d+)?)\)/)
          ?? lines[j].match(/at\s+(.+?:\d+(?::\d+)?)/);
        if (stackMatch) {
          location = stackMatch[1];
          break;
        }
      }
      failures.push({ kind: 'error', name: errMatch[1].trim(), location });
    }
  }
  return failures;
}

/**
 * Print a structured FAILURES summary so a non-zero exit always tells the
 * caller exactly what failed, in a stream-position they can find without
 * scrolling past tens of thousands of pass lines. The JUnit XMLs and the
 * per-phase logs remain on disk for deeper inspection.
 *
 * Two-source fusion:
 *   - JUnit XML for asserted-and-named failures with file:line metadata.
 *   - Tee'd log for file-load / uncaught / rejection errors that JUnit
 *     drops. Deduped by visible identity so the same test isn't listed twice.
 */
function printFailureSummary(phaseStatuses) {
  const allEntries = [];
  for (const { label, file: junitFile, log: logFile } of phaseStatuses) {
    // 1. JUnit-sourced asserted failures with file:line metadata. Collect the
    //    set of (file, line) pairs they already cover so log-sourced errors
    //    at the same location aren't duplicated.
    const junitFailures = parseFailuresFromJunit(junitFile);
    const junitFailureLocations = new Set();
    const junitFailureFiles = new Set();
    for (const f of junitFailures) {
      if (f.file && f.line) junitFailureLocations.add(`${f.file}:${f.line}`);
      if (f.file) junitFailureFiles.add(f.file);
      allEntries.push({
        phase: label,
        kind: 'fail',
        line: formatJunitEntry(label, f),
      });
    }
    // 2. Log-sourced entries — keep only what JUnit missed. An `error:` line
    //    whose stack frame points at a file:line already in the JUnit set is
    //    the same failure (just with the assertion message); skip it. A
    //    `(fail)` line that mentions a test already in JUnit is also a dupe.
    //    What's left is the "1 error" class JUnit silently drops: file-load
    //    errors, unhandled rejections, setup-time throws.
    //
    // Path normalization: Bun's log stack frames are absolute (under REPO);
    // JUnit `file=` attrs are repo-relative. Strip the repo prefix from log
    // locations before comparing.
    const repoPrefix = REPO.endsWith('/') ? REPO : REPO + '/';
    for (const f of parseFailuresFromLog(logFile)) {
      if (f.kind === 'error') {
        const normalized = f.location.startsWith(repoPrefix)
          ? f.location.slice(repoPrefix.length)
          : f.location;
        const fileColon = normalized.match(/^(.+?:\d+)/)?.[1] ?? '';
        const fileOnly = normalized.replace(/:\d+(?::\d+)?$/, '');
        if (fileColon && junitFailureLocations.has(fileColon)) continue;
        if (fileOnly && junitFailureFiles.has(fileOnly)) continue;
      }
      // Dedupe `(fail)` markers against JUnit by test-path tail.
      if (f.kind === 'fail') {
        const tail = f.name.split(' > ').pop()?.trim() ?? '';
        const alreadyInJunit = junitFailures.some((jf) => jf.name === tail);
        if (alreadyInJunit) continue;
      }
      allEntries.push({
        phase: label,
        kind: f.kind,
        line: `[${label}] ${f.kind === 'error' ? 'ERROR ' : ''}${f.name}${f.location ? ` (${f.location})` : ''}`,
      });
    }
  }
  if (allEntries.length === 0) return;
  console.log('\n=== FAILURES ===');
  for (const e of allEntries) {
    console.log(e.line);
  }
  console.log(`\n${allEntries.length} failure${allEntries.length === 1 ? '' : 's'}. Artifacts:`);
  for (const { label, file, log } of phaseStatuses) {
    if (fs.existsSync(file)) console.log(`  ${label} JUnit: ${file}`);
    if (fs.existsSync(log))  console.log(`  ${label} log:   ${log}`);
  }
}

function formatJunitEntry(label, f) {
  const suite = f.classname ? `${f.classname} > ` : '';
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
  const msg = f.message ? `\n  ${f.message.split('\n')[0].trim()}` : '';
  return `[${label}] ${suite}${f.name}${loc}${msg}`;
}

/**
 * npm installs a second copy of react + react-dom under
 * packages/myco/ui/node_modules whenever the ui workspace's peer versions
 * differ in any way from the root. When a tsx test then imports a component
 * via `packages/myco/ui/src/...`, that component resolves to the UI-local
 * React while `@testing-library/react` (from root) resolves to root's React.
 * Two React instances == broken hooks. Strip the duplicates before the tsx
 * pass; Bun.plugin `onResolve` hooks don't fire in time to re-route static
 * imports.
 */
function stripDuplicateReact() {
  const candidates = [
    path.join(REPO, 'packages/myco/ui/node_modules'),
    path.join(REPO, 'packages/myco-collective/ui/node_modules'),
    path.join(REPO, 'packages/myco-team/ui/node_modules'),
  ];
  for (const base of candidates) {
    for (const pkg of [
      'react',
      'react-dom',
      'react-router-dom',
      'react-router',
      '@tanstack/react-query',
      '@tanstack/query-core',
    ]) {
      const dupe = path.join(base, pkg);
      if (fs.existsSync(dupe)) {
        fs.rmSync(dupe, { recursive: true, force: true });
        console.log(`[run-bun-tests] removed duplicate ${pkg} at ${dupe}`);
      }
    }
  }
}

const { nonDomPhases, dom } = buildArgs();

// Audit the computed phase plan without executing. Lets a reviewer (or a CI
// guard) confirm every test file lands in exactly one phase — catching a file
// listed in both SOLO_NODE_FILES and a NO_ISOLATE group, which would otherwise
// run twice (once solo, once in the shared no-isolate process it was moved out
// of).
if (process.env.MYCO_RUNNER_DRY_RUN === '1') {
  const seen = new Map();
  for (const phase of [...nonDomPhases, ...(dom ? [{ label: 'jsdom', args: dom, isolate: true }] : [])]) {
    const files = phase.args.filter(
      (arg) => !arg.startsWith('-') && (arg.endsWith('.test.ts') || arg.endsWith('.test.tsx')),
    );
    console.log(`[dry-run] ${phase.isolate ? 'isolate' : 'shared '} ${phase.label}: ${files.length} file(s)`);
    for (const file of files) {
      console.log(`           ${file}`);
      seen.set(file, (seen.get(file) ?? 0) + 1);
    }
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicated.length > 0) {
    console.error(`[dry-run] FAIL — files scheduled in more than one phase:`);
    for (const [file, count] of duplicated) console.error(`  ${count}× ${file}`);
    process.exit(1);
  }
  console.log('[dry-run] OK — no file scheduled in more than one phase');
  process.exit(0);
}

const phaseReports = [];
resetReportDir();

let nonDomStatus = 0;
for (const phase of nonDomPhases) {
  const status = await runPhase(phase.label, phase.args, path.join(REPO, 'bunfig.toml'), { isolate: phase.isolate });
  nonDomStatus ||= status;
  phaseReports.push({
    label: phase.label,
    file: reportPath(phase.label),
    log: logPath(phase.label),
  });
}

let domStatus = 0;
if (dom !== null) {
  stripDuplicateReact();
  domStatus = await runPhase(
    'jsdom',
    dom,
    path.join(REPO, 'bunfig.dom.toml'),
    { isolate: true },
  );
  phaseReports.push({
    label: 'jsdom',
    file: reportPath('jsdom'),
    log: logPath('jsdom'),
  });
}

// Aggregate JUnit failures+errors across every phase report as a backstop against
// bun silently exiting 0 when tests fail (observed: 93 JUnit failures, exit 0).
// The runner exits non-zero if EITHER bun reported a non-zero exit code OR the
// JUnit aggregate shows any failure or error. Both must be zero for a green run.
function aggregateJunitFailures(reports) {
  let total = 0;
  for (const { file } of reports) {
    if (!fs.existsSync(file)) continue;
    let xml;
    try { xml = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of xml.matchAll(/<testsuite\b[^>]*/g)) {
      const failures = Number(m[0].match(/\bfailures="(\d+)"/)?.[1] ?? 0);
      const errors = Number(m[0].match(/\berrors="(\d+)"/)?.[1] ?? 0);
      total += failures + errors;
    }
  }
  return total;
}

const junitFailureCount = aggregateJunitFailures(phaseReports);
const exitCode = nonDomStatus || domStatus || (junitFailureCount > 0 ? 1 : 0);
if (exitCode !== 0) {
  if (junitFailureCount > 0 && (nonDomStatus || domStatus) === 0) {
    // bun exited 0 but JUnit reports failures — the false-green scenario.
    console.error(
      `\n[run-bun-tests] FAIL: bun exited 0 but JUnit aggregated ${junitFailureCount} failure(s)/error(s) across ${phaseReports.length} phase(s). Exiting non-zero.`,
    );
  }
  printFailureSummary(phaseReports);
}
process.exit(exitCode);

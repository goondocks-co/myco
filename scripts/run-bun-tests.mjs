#!/usr/bin/env node
// Drives `bun test` in two passes: non-tsx tests (pure Node environment) and
// tsx tests (jsdom via an explicit preload). Honors MYCO_TEST_PROFILE=fast |
// integration to match the former vitest-side configuration.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { SaxesParser } from 'saxes';
import { parseShard, selectShard } from './test-shards.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { sandboxTestHome } from './test-environment.mjs';
import { createTestTempRun, finishTestTempRun } from './test-temp-root.mjs';
import { registerTestProcess, stopRegisteredTestProcesses, stopTestProcessGroup } from './test-process-tree.mjs';

// ---------------------------------------------------------------------------
// Per-run temp root
// ---------------------------------------------------------------------------
// The runner owns the root before loading test modules or starting subprocesses.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT_TMPDIR = os.tmpdir();
const tempRun = createTestTempRun();
const RUN_ROOT = tempRun.root;
const BUNDLE_DIR = path.join(REPO, 'target', 'test-bundles', `node-env-${path.basename(RUN_ROOT)}`);
process.env.MYCO_TEST_RUN_PARENT_TMPDIR = PARENT_TMPDIR;

/** Kills the running group's process tree; null between groups. */
let killActiveGroup = null;
let runReportDir = null;
let interrupted = false;
let observedFailure = false;
let reportFailurePersistenceError = null;
let inspectActiveStreamTails = null;
// However the runner exits (the end of the run, a signal, an uncaught error),
// the group it was running dies with it and the root goes.
process.on('exit', () => {
  inspectActiveStreamTails?.();
  try {
    finishTestTempRun(tempRun, () => {
      try { killActiveGroup?.('SIGKILL'); }
      finally {
        try { stopRegisteredTestProcesses(RUN_ROOT); }
        finally { fs.rmSync(BUNDLE_DIR, { recursive: true, force: true }); }
      }
    });
  } finally {
    if (runReportDir) {
      try {
        const outcome = process.exitCode ? (interrupted && !observedFailure ? 'interrupted' : 'failed') : 'success';
        pruneRunReports(path.dirname(runReportDir), runReportDir, outcome);
        publishReportOutcome(runReportDir, outcome);
      } catch (error) {
        process.exitCode ||= 1;
        console.error(`[run-bun-tests] FAIL: cannot finalize report lifecycle: ${error.message}`);
        try { publishReportOutcome(runReportDir, 'failed'); }
        catch (statusError) { console.error(`[run-bun-tests] FAIL: cannot record failed report: ${statusError.message}`); }
      }
    }
  }
});
for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
  process.on(signal, () => { interrupted = true; process.exit(128 + number); });
}

// Node reads the account home independently of HOME; Bun's userInfo follows HOME.
process.env.MYCO_TEST_REAL_HOME = os.userInfo().homedir;

// Child runtimes receive home and PATH isolation before any preload executes.
sandboxTestHome(RUN_ROOT);

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
  process.env.MYCO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-home-'));
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
  process.env.MYCO_TEAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-team-home-'));
}

// ---------------------------------------------------------------------------
// Hermetic per-user lock namespace
// ---------------------------------------------------------------------------
// Production locks live in a fixed operating-system-account root so sibling
// processes coordinate even when HOME and TMPDIR differ. Tests receive a
// runner-owned root through a test-only handoff and pass an explicit lock
// namespace dependency into the operations they exercise.
const TEST_PER_USER_LOCKS_ROOT_ENV = 'MYCO_TEST_PER_USER_LOCKS_ROOT';
process.env[TEST_PER_USER_LOCKS_ROOT_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-locks-'));

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

// Wall-clock budget for one group, across every attempt including wedge
// retries. A group still running at its deadline has its process tree sampled
// into `<group>.hang.txt`, is killed, and is reported failed with its test
// files; the run continues with the next group. The slowest legitimate group
// in CI, `node env shared tests-myco-server`, takes 244-273s; a CI jsdom shard
// takes up to about 100s, and the unsharded local jsdom group about 135s.
// 600s is more than twice the slowest of them.
const GROUP_BUDGET_MS = Number(process.env.MYCO_RUNNER_GROUP_BUDGET_MS ?? 600000);

// Test prerequisites share the run's temp root and leak gate.
const generated = spawnSync(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/gen-worker-bundle.ts'], {
  cwd: REPO, env: process.env, stdio: 'inherit',
});
if (generated.error) throw generated.error;
if (generated.status !== 0) process.exit(generated.status ?? 1);

function resolveBunExecutable() {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `bun${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch { /* try the next PATH entry */ }
    }
  }
  throw new Error('[run-bun-tests] Bun executable is not available on the test PATH');
}

const BUN_EXECUTABLE = resolveBunExecutable();
const bunVersionResult = spawnSync(BUN_EXECUTABLE, ['--version'], { encoding: 'utf8' });
const BUN_VERSION = bunVersionResult.stdout?.trim() ?? '';
if (bunVersionResult.error || bunVersionResult.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(BUN_VERSION)) {
  throw new Error(`[run-bun-tests] cannot read version of ${BUN_EXECUTABLE}: ${bunVersionResult.error?.message ?? bunVersionResult.stderr?.trim() ?? 'invalid output'}`);
}

/** Compare the exact executable used for every test phase with the release pin. */
function warnOnBunVersionSkew() {
  let pinned;
  try {
    pinned = fs.readFileSync(path.join(REPO, '.bun-version'), 'utf-8').trim();
  } catch {
    return; // no pin to compare against
  }
  if (!pinned || pinned === BUN_VERSION) return;
  console.warn(
    `[run-bun-tests] WARNING: running Bun ${BUN_VERSION} (${BUN_EXECUTABLE}), but .bun-version pins ${pinned} — `
    + 'CI and the release binary use the pinned one. Runtime behaviour differs between Bun '
    + 'versions, so a green run here is not proof of a green run there.',
  );
}
warnOnBunVersionSkew();

const FAST_EXCLUDES = [
  'tests/integration/',
  'tests/smoke/',
];
const INTEGRATION_INCLUDES = [
  'tests/integration/',
  'tests/smoke/',
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
  'tests/canopy/describe',
  'tests/canopy/scanner',
  'tests/capture',
  'tests/config',
  'tests/deploy',
  'tests/grove',
  'tests/mcp',
  'tests/myco-server',
  'tests/myco-shared',
  'tests/plans',
  'tests/release-provenance',
  'tests/service',
  // 'tests/symbionts' intentionally omitted: installer.test.ts, installer-integration.test.ts,
  // installer-scope.test.ts, installer-invariants.test.ts and others all mutate process.env.HOME
  // and process.env.MYCO_HOME in beforeEach/afterEach. Under bun's default max-concurrency=20,
  // tests from different files can interleave within one shared bun process, creating a race on
  // process.env that produces ~93 spurious failures in the full suite (while passing in isolation
  // or in the scoped `npm test -- tests/symbionts/` run which uses --isolate per file). Each file
  // runs isolated below instead.
  'tests/symbionts/parsers',
  'tests/symbionts/templates',
  'tests/tools',
  'tests/utils',
  'tests/vault',
]);

// These targets pass as their own shared-process Bun run without `--isolate`.
// They are the first-class speed path: one process per clean domain, while
// leak-prone domains keep per-file isolation below.
const NO_ISOLATE_NODE_TARGETS = [
  'tests/agent/tasks',
  'tests/canopy',
  'tests/capture',
  'tests/config',
  'tests/db',
  'tests/grove',
  'tests/mcp',
  'tests/myco-server',
  'tests/myco-shared',
  'tests/plans',
  'tests/release-provenance',
  'tests/service',
  // 'tests/symbionts' intentionally omitted: see SAFE_NODE_BUNDLE_GROUPS comment above.
  // Root-level symbiont tests run per-file isolated to prevent process.env race conditions.
  'tests/tools',
  'tests/utils',
  'tests/vault',
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
  // The RSS fixture runs from a fresh launcher process.
  'tests/server/cloudflare-backup-streaming.test.ts',
  // This file spies on fs.fsyncSync to force publication races. The spy is
  // process-global and cannot overlap unrelated durable-write tests.
  'tests/config/secrets-relocate-legacy-project.test.ts',
];

const SOLO_NODE_REASON_LISTED_FILE = 'listed-solo-node-file';
const SOLO_NODE_REASON_MODULE_MOCK = 'mock.module';

const NO_ISOLATE_NODE_GROUPS = [
  {
    label: 'tests-agent-stable',
    targets: [
      'tests/agent/claude-code-executable.test.ts',
      'tests/agent/ollama-context.test.ts',
      'tests/agent/openai-runtime.test.ts',
      'tests/agent/openrouter-catalog.test.ts',
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
      'tests/daemon/port.test.ts',
      // machine-id.test.ts tests the real getMachineId() implementation, so
      // it must never share a process with a file that mocks
      // @myco/daemon/machine-id.js.
      'tests/daemon/machine-id.test.ts',
      'tests/daemon/subsystem-claim.test.ts',
    ],
  },
  {
    label: 'tests-daemon-api-stable',
    targets: [
      'tests/daemon/api/provider-secrets.test.ts',
      // tests/daemon/api/update.test.ts intentionally omitted — its top-level
      // `mock.module('@myco/daemon/update-checker.js', ...)` is hoisted by bun
      // ahead of the `await import(...)` that tries to capture the real module
      // for afterAll restoration, so the stub leaks for the rest of the bun
      // process. Running it isolated keeps the leak in its own bun process.
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
      'tests/daemon/grove-runtime-cache.test.ts',
      'tests/daemon/legacy-scope-removed.test.ts',
    ],
  },
  {
    label: 'tests-daemon-capture-backup',
    targets: [
      'tests/daemon/backup-canopy-roundtrip.test.ts',
    ],
  },
  {
    label: 'tests-daemon-power-sweeps',
    targets: [
      'tests/daemon/power-jobs.test.ts',
      'tests/daemon/tick-paths-pause.test.ts',
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

  fs.mkdirSync(BUNDLE_DIR, { recursive: true });

  const bundledTargets = [];
  let bundledFileCount = 0;

  for (const [key, groupFiles] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (groupFiles.length < 2) {
      isolated.push(...groupFiles);
      continue;
    }

    bundledFileCount += groupFiles.length;
    const relativeBundle = path.join('target', 'test-bundles', path.basename(BUNDLE_DIR), `${bundleSlug(key)}.test.ts`);
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
      `[run-bun-tests] bundled node env: ${bundledFileCount} files -> ${bundledTargets.length} bundles in ${path.relative(REPO, BUNDLE_DIR)}; ${isolated.length} files stay isolated`,
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
  if (SOLO_NODE_FILES.includes(file)) return SOLO_NODE_REASON_LISTED_FILE;
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

function noIsolateArgsForFiles(files, options) {
  return [
    ...options,
    ...files,
    "--path-ignore-patterns=**/*.test.tsx",
    ...(profile === 'fast' ? fastIgnoreArgs() : []),
  ];
}

// Shared targets too slow to be one group: each runs as this many shared
// processes over contiguous runs of its files, balanced by measured duration,
// so no single group bounds a CI shard.
const SPLIT_NO_ISOLATE_TARGETS = new Map([
  ['tests/myco-server', 3],
]);

/** `files`, in order, cut into at most `parts` contiguous runs of about equal measured duration. */
function splitByDuration(files, parts) {
  const weight = (file) => durations.files[file] ?? DEFAULT_FILE_DURATION_MS;
  const total = files.reduce((sum, file) => sum + weight(file), 0);
  const runs = [];
  let current = [];
  let seen = 0;
  files.forEach((file, index) => {
    current.push(file);
    seen += weight(file);
    const partsLeft = parts - runs.length - 1;
    if (partsLeft > 0 && seen >= (total * (runs.length + 1)) / parts && files.length - index - 1 >= partsLeft) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

function noIsolatePhasesForTarget(target, files, options) {
  const covered = sharedTargetFiles(target, files);
  const parts = SPLIT_NO_ISOLATE_TARGETS.get(target) ?? 1;
  const runs = parts > 1 ? splitByDuration(covered, parts) : [covered];
  return runs.map((run, index) => ({
    label: runs.length === 1 ? `node env shared ${bundleSlug(target)}` : `node env shared ${bundleSlug(target)}-${index + 1}`,
    args: noIsolateArgsForFiles(run, options),
    isolate: false,
  }));
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
    ...targets.flatMap((target) => noIsolatePhasesForTarget(target, sharedFiles, options)),
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
      // An explicitly named tsx test, `*.test.tsx` or a `*_test.tsx` fixture, runs under the DOM config.
      if (/[._]test\.tsx$/.test(file)) dom.push(file);
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
// and, for a group killed over budget or wedged, a third:
//   - <phase>.hang.txt  — ps, stack samples and open files of every process
//                         in the group's tree, taken just before the kill
// MYCO_RUNNER_REPORT_DIR moves them, so a runner driven from inside a test
// run never clears the outer run's reports.
const REPORT_DIR = process.env.MYCO_RUNNER_REPORT_DIR
  ? path.resolve(process.env.MYCO_RUNNER_REPORT_DIR)
  : path.join(REPO, 'target', 'test-reports');
const REPORT_OWNER_FILE = '.runner-owner.json';
const REPORT_OUTCOME_FILE = '.runner-outcome.json';
const SUCCESS_REPORT_RETAIN = 3;
const INTERRUPTED_REPORT_RETAIN = 2;

function publishReportOutcome(dir, status) {
  const temporary = path.join(dir, `${REPORT_OUTCOME_FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ status, finishedAt: Date.now() }));
    fs.renameSync(temporary, path.join(dir, REPORT_OUTCOME_FILE));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function recordObservedFailure() {
  if (observedFailure) return;
  observedFailure = true;
  if (!runReportDir) return;
  try { publishReportOutcome(runReportDir, 'failed'); }
  catch (error) {
    reportFailurePersistenceError = error;
    process.exitCode ||= 1;
    console.error(`[run-bun-tests] FAIL: cannot persist failed report ${runReportDir}: ${error.message}`);
  }
}

function ownerIsGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function warnReportMetadata(dir, field, error) {
  const reason = error instanceof SyntaxError ? 'invalid JSON' : (typeof error?.code === 'string' ? error.code : 'invalid shape');
  console.warn(`[run-bun-tests] WARN: preserving report ${dir}: ${field} ${reason}`);
}

function pruneRunReports(parent, current, currentOutcome = null) {
  const candidates = { success: [], interrupted: [] };
  for (const name of fs.readdirSync(parent)) {
    if (!/^run-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = path.join(parent, name);
    if (dir === current) continue;
    try { if (!fs.lstatSync(dir).isDirectory()) continue; }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, REPORT_OWNER_FILE), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') warnReportMetadata(dir, 'owner', error);
      continue;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.createdAt)) {
      warnReportMetadata(dir, 'owner', null);
      continue;
    }
    if (!ownerIsGone(owner.pid)) continue;
    let outcome;
    try { outcome = JSON.parse(fs.readFileSync(path.join(dir, REPORT_OUTCOME_FILE), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') { warnReportMetadata(dir, 'outcome', error); continue; }
    }
    if (outcome !== undefined && (!outcome || !['success', 'failed', 'interrupted'].includes(outcome.status) || !Number.isFinite(outcome.finishedAt))) {
      warnReportMetadata(dir, 'outcome', null);
      continue;
    }
    const status = outcome?.status ?? 'interrupted';
    if (!(status in candidates)) continue;
    candidates[status].push({ dir, time: outcome?.finishedAt ?? owner.createdAt });
  }
  for (const [status, keep] of [['success', SUCCESS_REPORT_RETAIN], ['interrupted', INTERRUPTED_REPORT_RETAIN]]) {
    const ordered = candidates[status].sort((a, b) => b.time - a.time || b.dir.localeCompare(a.dir));
    // The current terminal run consumes one slot of its retention class.
    for (const { dir } of ordered.slice(keep - Number(currentOutcome === status))) {
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

fs.mkdirSync(REPORT_DIR, { recursive: true });
const RUN_REPORT_DIR = fs.mkdtempSync(path.join(REPORT_DIR, 'run-'));
fs.writeFileSync(path.join(RUN_REPORT_DIR, REPORT_OWNER_FILE), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: 'wx' });
runReportDir = RUN_REPORT_DIR;
pruneRunReports(REPORT_DIR, RUN_REPORT_DIR);
function reportPath(label) {
  return path.join(RUN_REPORT_DIR, `${label.replace(/\s+/g, '-')}.junit.xml`);
}
function logPath(label) {
  return path.join(RUN_REPORT_DIR, `${label.replace(/\s+/g, '-')}.log`);
}
function hangPath(label) {
  return path.join(RUN_REPORT_DIR, `${label.replace(/[\s/]+/g, '-')}.hang.txt`);
}

// Groups killed at their wall-clock budget, in run order.
const overBudgetGroups = [];

/**
 * Replace a killed group's JUnit report with one failed testcase per test
 * file, so the aggregate and the failure summary count the group as failed
 * even though bun never wrote its own report.
 */
function writeOverBudgetJunit(reportFile, label, files) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const message = `group "${label}" exceeded its ${GROUP_BUDGET_MS}ms budget and was killed`;
  const cases = files.map((file) => `    <testcase name="${esc(file)}" classname="${esc(label)}" file="${esc(file)}">\n      <failure type="GroupBudgetExceeded" message="${esc(message)}" />\n    </testcase>`);
  fs.writeFileSync(reportFile, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${esc(label)}" tests="${files.length}" failures="${files.length}">`,
    `  <testsuite name="${esc(label)}" tests="${files.length}" failures="${files.length}" errors="0">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n'));
}

/**
 * Every process alive now, by pid: its parent, its process group, and when it
 * started. A pid and its start time together name one process; a pid alone
 * can name a later process that reused it. Null when the table cannot be read.
 */
function readProcessTable() {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 10000 });
  if (ps.error || ps.status !== 0) return null;
  const table = new Map();
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, ' ') });
  }
  return table;
}

/**
 * The processes of a group's tree in `table`: the members of its process group
 * (the group's bash wrapper is spawned detached, so its pid is the pgid) and
 * every descendant of a member that left the group. A wrapper that has exited
 * is absent, so a process that later reuses its pid is not mistaken for it.
 */
function groupTreeIn(table, pgid) {
  const pids = new Set([...table].filter(([, row]) => row.pgid === pgid).map(([pid]) => pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, row] of table) {
      if (pids.has(row.ppid) && !pids.has(pid)) { pids.add(pid); grew = true; }
    }
  }
  return pids;
}

/** Run a diagnostic command with a hard timeout and return what it printed. */
function diagnostic(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) return `(${command} unavailable: ${result.error.message})\n`;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Write where each process of a stuck group is blocked: its state, a stack
 * sample (`sample` on macOS, the kernel wait channel and stack on Linux) and
 * its open files. The report names the pids so the evidence is readable
 * after the tree is killed.
 */
function captureHangDiagnostics(pids, hangFile, heading) {
  const sections = [`${heading}\n`, `pids: ${pids.join(' ')}\n`];
  if (pids.length > 0) sections.push('\n--- ps\n', diagnostic('ps', ['-o', 'pid,ppid,pgid,stat,%cpu,etime,command', '-p', pids.join(',')]));
  for (const pid of pids) {
    sections.push(`\n=== pid ${pid}\n`);
    if (process.platform === 'darwin') {
      // The loaded-image table that closes a sample is long and names no frame.
      sections.push('--- sample (3s)\n', diagnostic('sample', [String(pid), '3']).split('\nBinary Images:')[0], '\n');
    } else if (process.platform === 'linux') {
      for (const entry of ['status', 'wchan', 'stack', 'syscall']) {
        let text;
        try { text = fs.readFileSync(`/proc/${pid}/${entry}`, 'utf8'); } catch (error) { text = `(${error.code ?? error.message})`; }
        sections.push(`--- /proc/${pid}/${entry}\n${text}\n`);
      }
    }
    sections.push('--- lsof\n', diagnostic('lsof', ['-p', String(pid)]));
  }
  const text = redactSecrets(sections.join(''));
  try { fs.appendFileSync(hangFile, text); } catch { /* best-effort */ }
  return text;
}


async function runPhase(label, extraArgs, preloads, { isolate, files }) {
  if (extraArgs === null || extraArgs.length === 0) return 0;
    console.log(`\n=== bun test (${label}) ===`);
    const reportFile = reportPath(label);
    const teeFile = logPath(label);
    fs.writeFileSync(teeFile, ''); // start empty so re-runs don't append stale data
    // Always emit a JUnit XML report alongside the human-readable stream.
    // We tee stdout+stderr to both the terminal AND a local log file so a
    // post-run scan can recover the "1 error" class that Bun's JUnit
    // reporter drops (file-load errors, unhandled rejections, etc.).
    const args = [
      'test',
      ...preloads.flatMap((preload) => ['--preload', preload]),
      ...(isolate ? ['--isolate'] : []),
      // Default per-test timeout, raised from bun's 5s. The suite creates real
      // vault schemas and reads real files per test, and shared CI runners
      // have been measured running the same case 15x slower than idle
      // (~0.4s -> ~6s) — so ANY test over ~300ms idle can blow a 5s budget
      // under contention, and three different suites did in one day, each
      // green on re-run. Tests that wait on time use injected clocks (the
      // comments gate keeps them honest), so this budget masks nothing but
      // runner load; a genuinely hung test still fails, just at 30s. An
      // explicit --timeout from the caller wins.
      ...(extraArgs.some((a) => a === '--timeout' || a.startsWith('--timeout=')) ? [] : ['--timeout', '30000']),
      '--reporter=junit',
      `--reporter-outfile=${reportFile}`,
      ...extraArgs,
    ];
    // A wedge-kill (exit 124, no test output) is never a real assertion
    // failure — it's the synchronous bun `--isolate` runtime spin that this
    // workload triggers non-deterministically. Because the phase-kill leaves
    // no orphan to poison a re-run, retrying the wedged phase recovers a
    // clean pass without masking any genuine failure (a real failure exits
    // with assertion output and `wedged:false`, so it is never retried).
    // Every attempt shares one deadline, so retries never extend a group past
    // its budget.
    const deadlineMs = Date.now() + GROUP_BUDGET_MS;
    const hangFile = hangPath(label);
    fs.rmSync(hangFile, { force: true });
    let { status, wedged, overBudget, evidenceError, streamFailure } = await runWithTeeAndHeartbeat(BUN_EXECUTABLE, args, teeFile, label, { deadlineMs, hangFile });
    for (let attempt = 1; wedged && !overBudget && !evidenceError && !streamFailure && attempt <= WEDGE_RETRIES && Date.now() < deadlineMs; attempt += 1) {
      const note = `[run-bun-tests] RETRYING ${label} after wedge-kill (attempt ${attempt}/${WEDGE_RETRIES})\n`;
      process.stderr.write(note);
      fs.writeFileSync(teeFile, ''); // fresh log for the retry
      ({ status, wedged, overBudget, evidenceError, streamFailure } = await runWithTeeAndHeartbeat(BUN_EXECUTABLE, args, teeFile, label, { deadlineMs, hangFile }));
    }
    if (overBudget) {
      overBudgetGroups.push({ label, files, hangFile });
      writeOverBudgetJunit(reportFile, label, files);
    }
    const evidence = evaluatePhaseEvidence([{ label, file: reportFile, log: teeFile }]);
    if (status !== 0 || evidence.failures > 0 || evidence.invalid.length > 0) recordObservedFailure();
    if (evidence.failures > 0 || evidence.invalid.length > 0) {
      console.error(`[run-bun-tests] FAIL: ${label} completion evidence: ${evidence.invalid.join('; ') || `${evidence.failures} JUnit failure(s)/error(s)`}`);
    }
    return status || (reportFailurePersistenceError ? 1 : 0);
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
  const xml = fs.readFileSync(file, 'utf8');
  const failures = [];
  const pairedTestcasePattern =
    /<testcase\b([^>]*?)(?<!\/)\s*>([\s\S]*?)<\/testcase>/g;
  for (const match of xml.matchAll(pairedTestcasePattern)) {
    const attrs = match[1];
    const body = match[2];
    if (!/<(?:failure|error)\b/.test(body)) continue;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? '(unnamed)';
    const classname = attrs.match(/\bclassname="([^"]*)"/)?.[1] ?? '';
    const sourceFile = attrs.match(/\bfile="([^"]*)"/)?.[1] ?? '';
    const lineNo = attrs.match(/\bline="([^"]*)"/)?.[1] ?? '';
    // Bun's `<failure>` is usually `<failure type="AssertionError" />` with
    // no message attribute; the human-readable message is on stdout. We
    // still try to surface `message` and `type` when present.
    const failureMessage = body.match(/<(?:failure|error)[^>]*\bmessage="([^"]*)"/)?.[1] ?? '';
    const failureType = body.match(/<(?:failure|error)[^>]*\btype="([^"]*)"/)?.[1] ?? '';
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

/** Run a command directly, tee its output, and enforce quiet and wall-clock budgets. */
async function runWithTeeAndHeartbeat(command, args, teeFile, label, { deadlineMs, hangFile }) {
  const startMs = Date.now();
  process.stderr.write(`[run-bun-tests] STARTING ${label}\n`);

  return new Promise((resolve) => {
    let evidenceError = null;
    let streamFailure = false;
    function appendEvidence(text) {
      if (evidenceError) return;
      try { fs.appendFileSync(teeFile, text); }
      catch (error) {
        evidenceError = error;
        recordObservedFailure();
        process.stderr.write(`[run-bun-tests] FAIL: cannot append mandatory log ${teeFile}: ${error.message}\n`);
      }
    }
    // POSIX phase termination signals the detached process group and its workers.
    // Tests reading stdin receive EOF.
    const child = spawn(command, args, {
      cwd: REPO,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    killActiveGroup = (signal) => killPhaseTree(signal);
    if (child.pid) registerTestProcess(child, tempRun.root);

    let killedForHang = false;
    let killedForBudget = false;
    /** The SIGKILL that follows a kill; the group settles only once it has been sent. */
    let escalation = null;
    /**
     * The processes this group spawned, as captured when it was found stuck:
     * pid to start time. A captured process stays a target wherever it has
     * moved since, including a descendant reparented when its parent died.
     */
    let captured = null;
    // Signals only processes this group spawned: every captured process that
    // is still the same process (same pid, same start time), every process in
    // the group's tree now, and the process group while one of them belongs to
    // it. A pid reused by an unrelated process is never signalled, and a
    // process group id cannot be reused while a member lives.
    function killPhaseTree(signal) {
      if (process.platform === 'win32') {
        stopTestProcessGroup(child.pid, signal);
        return;
      }
      const table = readProcessTable();
      if (table === null) {
        // No process table to read: the process group is all that can be named.
        try { process.kill(-child.pid, signal); } catch { /* already gone */ }
        return;
      }
      const targets = groupTreeIn(table, child.pid);
      for (const [pid, started] of captured ?? []) {
        if (table.get(pid)?.started === started) targets.add(pid);
      }
      if ([...targets].some((pid) => table.get(pid)?.pgid === child.pid)) {
        try { process.kill(-child.pid, signal); } catch { /* already gone */ }
      }
      for (const pid of targets) {
        try { process.kill(pid, signal); } catch { /* already gone */ }
      }
    }
    function reportAndKill(heading) {
      const table = readProcessTable();
      const pids = table === null ? [] : [...groupTreeIn(table, child.pid)].sort((a, b) => a - b);
      captured = table === null ? null : new Map(pids.map((pid) => [pid, table.get(pid).started]));
      process.stderr.write(`${heading}\n[run-bun-tests] sampling ${pids.length} process(es) of ${label} into ${hangFile}\n`);
      const diagnostics = captureHangDiagnostics(pids, hangFile, heading);
      appendEvidence(`${heading}\n${diagnostics}`);
      killPhaseTree('SIGTERM');
      // Escalate shortly after, in case anything ignored SIGTERM. The timer is
      // held, and the group waits for it, so the runner never moves on or exits
      // with a captured process still alive.
      escalation = new Promise((done) => { setTimeout(() => { killPhaseTree('SIGKILL'); done(); }, 2000); });
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
      appendEvidence(text);
      // Track the last non-empty line for the watchdog heartbeat.
      const combined = tailRef.value + text;
      const lines = combined.split(/\r?\n/);
      tailRef.value = lines.pop() ?? '';
      for (const line of lines) {
        if (outputHasFailureMarker(line)) { streamFailure = true; recordObservedFailure(); }
        const trimmed = line.trim();
        if (trimmed) {
          lastNonEmptyLine = trimmed;
          lastOutputMs = Date.now();
        }
      }
    }
    const stdoutRef = { value: stdoutTail };
    const stderrRef = { value: stderrTail };
    function inspectStreamTails() {
      if (outputHasFailureMarker(stdoutRef.value) || outputHasFailureMarker(stderrRef.value)) {
        streamFailure = true;
        recordObservedFailure();
      }
    }
    inspectActiveStreamTails = inspectStreamTails;
    child.stdout.on('data', (c) => ingest(c, process.stdout, stdoutRef));
    child.stderr.on('data', (c) => ingest(c, process.stderr, stderrRef));

    function checkDeadlines() {
      if (killedForHang || killedForBudget) return;
      const now = Date.now();
      const totalElapsed = now - startMs;
      if (now >= deadlineMs) {
        killedForBudget = true;
        reportAndKill(`[run-bun-tests] OVER BUDGET ${label} — still running at its ${GROUP_BUDGET_MS}ms group budget (${totalElapsed}ms this attempt); killing its process tree. Last line: ${lastNonEmptyLine || '(none)'}`);
        return;
      }
      const sinceLastOutput = now - lastOutputMs;
      if (sinceLastOutput >= PHASE_KILL_QUIET_MS) {
        killedForHang = true;
        reportAndKill(`[run-bun-tests] WEDGED ${label} — no output for ${sinceLastOutput}ms (>${PHASE_KILL_QUIET_MS}ms), ${totalElapsed}ms elapsed; killing phase tree. Last line: ${lastNonEmptyLine || '(none)'}`);
        return;
      }
      if (sinceLastOutput >= WATCHDOG_QUIET_MS) {
        const msg = `[run-bun-tests] STILL RUNNING ${label} — ${totalElapsed}ms elapsed, ${sinceLastOutput}ms since last output; last line: ${lastNonEmptyLine || '(none)'}\n`;
        process.stderr.write(msg);
        appendEvidence(msg);
      }
    }
    // The budget fires on time even when it falls between heartbeat ticks.
    const budgetTimer = setTimeout(checkDeadlines, Math.max(0, deadlineMs - Date.now()));
    budgetTimer.unref?.();

    const watchdog = setInterval(checkDeadlines, WATCHDOG_INTERVAL_MS);
    // Don't keep the event loop alive purely for the heartbeat — the
    // child's pipes are the load-bearing references that hold the
    // process open.
    watchdog.unref?.();

    child.on('error', (err) => {
      clearInterval(watchdog);
      clearTimeout(budgetTimer);
      process.stderr.write(`[run-bun-tests] FAILED TO SPAWN ${label}: ${err?.message ?? err}\n`);
      resolve({ status: 1, wedged: false, overBudget: false });
    });

    let settled = false;
    function settle(code) {
      if (settled) return;
      if (process.platform !== 'win32' && child.pid) stopTestProcessGroup(child.pid, 'SIGKILL');
      settled = true;
      inspectActiveStreamTails = null;
      killActiveGroup = null;
      clearInterval(watchdog);
      clearTimeout(budgetTimer);
      const totalMs = Date.now() - startMs;
      const tail = lastNonEmptyLine ? ` (last line: ${lastNonEmptyLine})` : '';
      const killed = killedForHang || killedForBudget;
      const exit = killed ? 124 : (code ?? 1);
      const verb = killedForBudget ? 'KILLED (over budget)' : killedForHang ? 'KILLED (wedged)' : 'FINISHED';
      const completion = `[run-bun-tests] ${verb} ${label} in ${totalMs}ms (exit ${exit})${tail}\n`;
      process.stderr.write(completion);
      inspectStreamTails();
      appendEvidence(completion);
      if (streamFailure) process.stderr.write(`[run-bun-tests] FAIL: ${label} stream reported a failure or error\n`);
      const outcome = { status: exit || evidenceError || streamFailure || reportFailurePersistenceError ? (exit || 1) : 0, wedged: killedForHang, overBudget: killedForBudget, evidenceError, streamFailure };
      if (escalation === null) resolve(outcome);
      else escalation.then(() => resolve(outcome));
    }
    child.on('close', settle);
    // After a kill, a process outside the tree that inherited the group's
    // pipes could hold them open and withhold 'close'; the group settles once
    // its own wrapper has exited and the pipes have had a moment to drain.
    child.on('exit', (code) => {
      if (!killedForHang && !killedForBudget) return;
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code);
      }, 5000).unref?.();
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
    text = stripVTControlCharacters(fs.readFileSync(file, 'utf8'));
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
    let junitFailures = [];
    try { junitFailures = parseFailuresFromJunit(junitFile); }
    catch { /* evidence error is reported by evaluatePhaseEvidence */ }
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

/**
 * Name every group killed at its budget, with its test files and the file
 * holding the stack samples and open files captured before the kill.
 */
function printOverBudgetSummary() {
  if (overBudgetGroups.length === 0) return;
  console.log(`\n=== OVER BUDGET (killed at ${GROUP_BUDGET_MS}ms) ===`);
  for (const { label, files, hangFile } of overBudgetGroups) {
    console.log(`[${label}] diagnostics: ${hangFile}`);
    for (const file of files) console.log(`  ${file}`);
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
 * packages/myco-server/ui/node_modules whenever the dashboard's peer versions
 * differ in any way from the root. When a tsx test then imports a component
 * via `packages/myco-server/ui/src/...`, that component resolves to the UI-local
 * React while `@testing-library/react` (from root) resolves to root's React.
 * Two React instances == broken hooks. Strip the duplicates before the tsx
 * pass; Bun.plugin `onResolve` hooks don't fire in time to re-route static
 * imports.
 */
function stripDuplicateReact() {
  const candidates = [
    path.join(REPO, 'packages/myco-server/ui/node_modules'),
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

const testKind = process.env.MYCO_TEST_KIND ?? 'all';
if (!['all', 'node', 'dom'].includes(testKind)) throw new Error(`Unknown test kind: ${testKind}`);
const shard = parseShard(process.env.MYCO_TEST_SHARD);
const durations = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/test-durations.json'), 'utf8'));
const DEFAULT_FILE_DURATION_MS = 100;
const built = buildArgs();
const testFiles = (args) => args.filter((arg) => !arg.startsWith('-') && /[._]test\.tsx?$/.test(arg));
const bundledFiles = (file) => (file.startsWith('target/test-bundles/')
  ? [...fs.readFileSync(path.join(REPO, file), 'utf8').matchAll(/import '\.\.\/\.\.\/\.\.\/(.*?)';/g)].map((match) => match[1])
  : [file]);
const sourceFiles = (args) => testFiles(args).flatMap(bundledFiles);
// The files a group runs, named however they were passed: every argument
// that is a file on disk, with generated bundles expanded to their sources.
const groupFiles = (args) => args
  .filter((arg) => !arg.startsWith('-') && fs.statSync(path.resolve(REPO, arg), { throwIfNoEntry: false })?.isFile())
  .flatMap(bundledFiles);
const estimate = (files) => Math.max(1, files.reduce((sum, file) => sum + (durations.files[file] ?? DEFAULT_FILE_DURATION_MS), 0));
const candidates = [
  ...(testKind === 'dom' ? [] : built.nonDomPhases.map((phase) => ({ ...phase, kind: 'node' }))),
  ...(testKind === 'node' || built.dom === null ? [] : testFiles(built.dom).map((file) => ({
    label: file, args: [file], isolate: true, kind: 'dom',
  }))),
];
const selected = selectShard(candidates, shard, (phase) => estimate(sourceFiles(phase.args)));
const nonDomPhases = selected.filter((phase) => phase.kind === 'node');
const selectedDomFiles = selected.filter((phase) => phase.kind === 'dom').flatMap((phase) => phase.args);
const dom = selectedDomFiles.length > 0
  ? [...built.dom.filter((arg) => !testFiles([arg]).length), ...selectedDomFiles]
  : null;
const manifest = selected.map((phase) => ({ label: phase.label, files: sourceFiles(phase.args), estimatedMs: estimate(sourceFiles(phase.args)) }));
console.log(`[run-bun-tests] ${testKind} shard ${shard.index}/${shard.count}: ${selected.length} groups, estimated ${Math.round(manifest.reduce((sum, phase) => sum + phase.estimatedMs, 0) / 1000)}s`);
if (process.env.MYCO_RUNNER_PLAN_FILE) {
  fs.writeFileSync(process.env.MYCO_RUNNER_PLAN_FILE, JSON.stringify(manifest, null, 2) + '\n');
}

// Audit the computed phase plan without executing. Lets a reviewer (or a CI
// guard) confirm every test file lands in exactly one phase — catching a file
// listed in both SOLO_NODE_FILES and a NO_ISOLATE group, which would otherwise
// run twice (once solo, once in the shared no-isolate process it was moved out
// of).
if (process.env.MYCO_RUNNER_DRY_RUN === '1') {
  const seen = new Map();
  for (const phase of [...nonDomPhases, ...(dom ? [{ label: 'jsdom', args: dom, isolate: true }] : [])]) {
    const files = sourceFiles(phase.args);
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
const NODE_PRELOAD = './tests/setup/sandbox-preload.ts';
const DOM_PRELOADS = ['./tests/setup/jsdom.ts', NODE_PRELOAD];

let nonDomStatus = 0;
for (const phase of nonDomPhases) {
  const status = await runPhase(phase.label, phase.args, [NODE_PRELOAD], { isolate: phase.isolate, files: groupFiles(phase.args) });
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
    DOM_PRELOADS,
    { isolate: true, files: groupFiles(dom) },
  );
  phaseReports.push({
    label: 'jsdom',
    file: reportPath('jsdom'),
    log: logPath('jsdom'),
  });
}

function readJunitEvidence(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const parser = new SaxesParser();
  let root = '';
  let suiteCount = 0;
  let suiteDepth = 0;
  let declaredTests = 0;
  let caseCount = 0;
  let declaredFailures = 0;
  let failureNodes = 0;
  parser.on('error', (error) => { throw error; });
  parser.on('opentag', ({ name, attributes }) => {
    if (!root) root = name;
    if (name === 'testsuite') {
      suiteCount += 1;
      if (suiteDepth === 0) {
        for (const field of ['tests', 'failures']) {
          if (!/^\d+$/.test(attributes[field] ?? '')) throw new Error(`testsuite ${field} must be a nonnegative integer`);
        }
        if (attributes.errors !== undefined && !/^\d+$/.test(attributes.errors)) throw new Error('testsuite errors must be a nonnegative integer');
        declaredTests += Number(attributes.tests);
        declaredFailures += Number(attributes.failures) + Number(attributes.errors ?? 0);
      }
      suiteDepth += 1;
    }
    if (name === 'testcase') caseCount += 1;
    if (name === 'failure' || name === 'error') failureNodes += 1;
  });
  parser.on('closetag', ({ name }) => { if (name === 'testsuite') suiteDepth -= 1; });
  parser.write(xml).close();
  if (!['testsuites', 'testsuite'].includes(root) || suiteCount === 0) throw new Error('missing JUnit testsuite');
  if (declaredTests === 0 || caseCount === 0) throw new Error('JUnit records zero executed tests');
  if (caseCount !== declaredTests) throw new Error(`JUnit declares ${declaredTests} tests but records ${caseCount} testcases`);
  return Math.max(declaredFailures, failureNodes);
}

function outputHasFailureMarker(text) {
  const log = stripVTControlCharacters(text);
  return /^\s*[1-9]\d*\s+(?:fail|error)\b/m.test(log)
    || /^\(fail\)\s+/m.test(log)
    || /^error:\s+\S/m.test(log);
}

function readLogEvidence(file) {
  return outputHasFailureMarker(fs.readFileSync(file, 'utf8'));
}

function evaluatePhaseEvidence(reports) {
  let failures = 0;
  const invalid = [];
  for (const { label, file, log } of reports) {
    try { failures += readJunitEvidence(file); }
    catch (error) { invalid.push(`${label} JUnit ${file}: ${error.message}`); }
    try {
      if (readLogEvidence(log)) invalid.push(`${label} log ${log}: Bun reported a failure or error`);
    } catch (error) { invalid.push(`${label} log ${log}: ${error.message}`); }
  }
  return { failures, invalid };
}

const { failures: junitFailureCount, invalid: invalidEvidence } = evaluatePhaseEvidence(phaseReports);
const exitCode = nonDomStatus || domStatus || (observedFailure || junitFailureCount > 0 || invalidEvidence.length > 0 || reportFailurePersistenceError ? 1 : 0);
if (exitCode !== 0) {
  for (const issue of invalidEvidence) console.error(`[run-bun-tests] FAIL: ${issue}`);
  if (junitFailureCount > 0 && (nonDomStatus || domStatus) === 0) {
    // bun exited 0 but JUnit reports failures — the false-green scenario.
    console.error(
      `\n[run-bun-tests] FAIL: bun exited 0 but JUnit aggregated ${junitFailureCount} failure(s)/error(s) across ${phaseReports.length} phase(s). Exiting non-zero.`,
    );
  }
  printFailureSummary(phaseReports);
  printOverBudgetSummary();
}
process.exitCode = exitCode;

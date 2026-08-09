---
name: myco:bun-test-runtime-hardening
description: |
  Apply this skill when hardening Bun test environments in Myco's test suite,
  diagnosing CI-only test failures, investigating hung test processes after all
  assertions pass, or adding new test files that import external SDK modules,
  use mock.module(), or declare module-level timers — even if the user doesn't
  explicitly ask about Bun runtime behavior. Covers three procedures: (1) isolating
  process-scoped mock.module() registrations that leak across test files and cause
  non-deterministic CI failures; (2) scoping module-level side effects (timers,
  stubs) to individual tests with explicit afterEach cleanup to prevent suite-exit
  hangs; and (3) lazily initializing external SDK clients (e.g., Anthropic) that
  eagerly construct at module load time under Bun's browser-like test environment.
  The shared root cause: Bun runs tests in a process-shared environment where
  module-scope state — mock registrations, timers, SDK clients — persists beyond
  the originating file.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Bun Test Runtime Hardening

Bun runs its test suite in a shared process where module-scope state persists
across test files. This creates three categories of hard-to-diagnose failures:
process-scoped mock registrations that poison unrelated tests, module-level
timers that block suite exit, and eager SDK construction that fails in Bun's
browser-like environment. These issues typically surface only on CI — due to
non-deterministic file execution order — or after extended test runs.

## Prerequisites

- You are working within Myco's monorepo test suite, executed via `npm test`
  or direct `bun test` invocations
- Understand that `npm test` delegates to `node scripts/run-bun-tests.mjs`,
  which orchestrates multiple Bun process invocations. Files in the same
  `NO_ISOLATE_NODE_GROUPS` entry share a Bun process.
- To reproduce CI ordering locally, run `bun test --watch=false` on the same
  group of files that CI bundles together (e.g., the `tests-agent-stable` group
  in `scripts/run-bun-tests.mjs`).

## Procedure A: Isolating Process-Scoped mock.module() Registrations

**When to apply:** A test file uses top-level `mock.module()` calls outside any
`beforeEach`/`describe` block, and other test files that import the same module
fail non-deterministically on CI.

**Root cause:** Bun's `mock.module()` is **process-scoped, not file-scoped**.
When multiple test files share one Bun process (i.e., they are in the same
`NO_ISOLATE_NODE_GROUPS` entry in `scripts/run-bun-tests.mjs`), a top-level
`mock.module()` call in file A replaces the real module for every subsequent
file in that process. `beforeEach`/`afterEach` sandboxing **cannot** undo
process-level mock registrations — the only cure is process isolation.

**Known occurrence in Myco:**
- Offending file: `tests/agent/runtime-claude.test.ts`
- Mocked modules: `@myco/agent/provider.js`, `@myco/agent/harness/claude-code-executable.js`
- Poisoned files when bundled: `tests/agent/provider.test.ts`, `tests/agent/claude-code-executable.test.ts`
- Symptom: 12 failures + 3 errors on CI; passes locally (different execution order)
- Current fix: `tests/agent/runtime-claude.test.ts` is intentionally omitted from
  the `tests-agent-stable` group in `scripts/run-bun-tests.mjs` so it runs in
  its own Bun process

**Steps:**

1. **Identify top-level mock.module() calls.** Search for registrations not
   nested inside a test hook:
   ```bash
   grep -rn "mock\.module(" tests/ --include="*.ts"
   ```
   Flag any result that isn't inside a `describe(`, `beforeEach(`, or `test(`
   block.

2. **Confirm the leak.** Verify that the mocked module path is also imported
   directly (not via the mock) by another test file that shares a Bun process
   group. If yes, that file is vulnerable to poisoning.

3. **Isolate the offending file** by ensuring it runs in its own Bun process.
   Two options:

   *Option A — Remove from shared group in `scripts/run-bun-tests.mjs` (preferred):*
   ```js
   // In the relevant NO_ISOLATE_NODE_GROUPS entry, remove or comment out the file:
   {
     label: 'tests-agent-stable',
     targets: [
       // 'tests/agent/runtime-claude.test.ts', // intentionally omitted:
       // top-level mock.module() calls for @myco/agent/provider.js and
       // @myco/agent/harness/claude-code-executable.js are process-global
       // and can poison provider/executable tests when Bun's platform-
       // dependent file order runs runtime-claude first.
       'tests/agent/provider.test.ts',
       // ... other stable files
     ],
   }
   ```
   The file will then be picked up by the per-file isolated pass automatically.

   *Option B — Separate bun test invocation:*
   ```bash
   bun test tests/agent/runtime-claude.test.ts
   bun test tests/agent/provider.test.ts tests/agent/claude-code-executable.test.ts
   ```

4. **Verify.** Run `npm test` (the full suite) at least 3 times. Confirm the
   previously failing tests are consistently stable, then check CI.

**Rule:** `mock.module()` should be a last resort due to its process-scope
semantics. Prefer dependency injection, seed-based fixtures, or wrapper modules
that accept injectable collaborators where possible.

## Procedure B: Cleaning Up Module-Level Side Effects

**When to apply:** The test suite hangs after all assertions complete, or CI
reports failures well past the expected test duration (e.g., the suite hangs
4+ minutes when tests normally take ~3 minutes).

**Root cause:** Any `setTimeout`, `setInterval`, stub, or mock declared at the
top level of a test file (outside `beforeEach`/`afterEach`) persists in the
shared Bun process and holds the event loop open, preventing clean suite exit.
This is invisible locally if developers kill the process manually.

**Known occurrence in Myco:**
- File: `tests/utils/instrumented-fetch.test.ts`
- A `setTimeout(..., 5000)` for the idle-stream watchdog test was declared at
  module scope and never explicitly cleared
- Symptom: CI hangs ~4 minutes after all assertions pass; CI run `26519943740`
  confirmed the fix (suite completed in 3m24s)

**Steps:**

1. **Confirm the hang.** Run with a verbose output tail:
   ```bash
   npm test 2>&1 | tail -30
   ```
   If output stops printing but the process doesn't exit after all test results
   are logged, a pending async handle (timer, open socket) is holding Bun open.

2. **Find module-level side effects.** Search for timer declarations and stub
   assignments that appear before the first `describe(` or `test(` block:
   ```bash
   grep -n "setTimeout\|setInterval\|stub\|mock\." tests/ -r --include="*.ts"
   ```
   Review each match in context to determine if it's at module scope.

3. **Move setup into test hooks.** Convert module-level initialization to
   `beforeEach`/`afterEach` pairs:
   ```ts
   // BEFORE: module-level — timer persists after tests complete
   const watchdogTimer = setTimeout(() => { ... }, 5000);

   // AFTER: scoped to each test — cleared in afterEach
   let watchdogTimer: ReturnType<typeof setTimeout>;

   beforeEach(() => {
     watchdogTimer = setTimeout(() => { ... }, 5000);
   });

   afterEach(() => {
     clearTimeout(watchdogTimer);
   });
   ```

4. **Clean up stubbed globals explicitly in afterEach.** If a test replaces
   a global like `fetch` or `Date`, restore it after every test:
   ```ts
   let originalFetch: typeof fetch;

   beforeEach(() => {
     originalFetch = global.fetch;
     global.fetch = mockFetch;
   });

   afterEach(() => {
     global.fetch = originalFetch;
   });
   ```

5. **Verify locally.** Run the specific test file and confirm it exits cleanly:
   ```bash
   bun test tests/utils/instrumented-fetch.test.ts
   ```
   Then run the full suite and confirm no hang.

**Rule:** If state is declared outside a test block, it needs explicit cleanup
in `afterEach`. There are no exceptions in a shared Bun process.

## Procedure C: Lazy SDK Client Initialization

**When to apply:** A test file (or a module it imports) imports an external SDK
whose client is constructed at module load time, and the test suite fails with
initialization errors *before* any test assertions run.

**Root cause:** Bun's test environment is browser-like (jsdom mode). External
SDKs — particularly the Anthropic SDK — access Node-specific environment state
(auth tokens, HTTP adapters, `process.env`) inside their constructors. When Bun
loads a module that eagerly constructs such a client, the constructor runs in
the browser-like context and throws, blocking the entire test file before the
first assertion.

**Known occurrence in Myco:**
- File: `packages/myco/src/intelligence/anthropic.ts` (`AnthropicBackend` class)
- Symptom: `make build` fails with Anthropic test errors even though the feature
  code is correct; the failure is pre-existing on the base branch, not caused by
  the feature under development
- Current fix: `AnthropicBackend` defers `new Anthropic(...)` to the private
  `getClient()` method called on first use; passes `dangerouslyAllowBrowser: true`
  to suppress Bun's browser-environment detection error

**Steps:**

1. **Identify eager construction.** Search for top-level SDK client instantiation
   in files that tests import:
   ```bash
   grep -rn "new Anthropic\|new OpenAI\|new.*Client(" packages/ --include="*.ts" \
     | grep -v "function\|=>\|class\|test\|spec"
   ```

2. **Apply the lazy initialization pattern.** Two variants depending on module
   structure:

   *Module-level (standalone functions) — illustrative names, adapt to your module:*
   ```ts
   // BEFORE: eager — fails at module load in Bun test env
   const client = new Anthropic({
     apiKey: process.env.ANTHROPIC_API_KEY,
   });

   // AFTER: lazy — only constructed when backend actually needs it
   let client: Anthropic | null = null;

   function getClient(): Anthropic {
     if (!client) {
       client = new Anthropic({
         apiKey: process.env.ANTHROPIC_API_KEY,
         dangerouslyAllowBrowser: true, // required in Bun's browser-like env
       });
     }
     return client;
   }
   ```

   *Class-based (as used in `AnthropicBackend` in `packages/myco/src/intelligence/anthropic.ts`):*
   ```ts
   // BEFORE: eager in constructor
   constructor(config?: AnthropicConfig) {
     this.client = new Anthropic({ dangerouslyAllowBrowser: true });
   }

   // AFTER: nullish-coalescing assignment in private getter
   private client?: Anthropic;

   private getClient(): Anthropic {
     this.client ??= new Anthropic({ dangerouslyAllowBrowser: true });
     return this.client;
   }
   ```

3. **Update all call sites.** Replace direct `client.xxx()` references with
   `getClient().xxx()` throughout the module.

4. **Verify.** Run the previously failing test file:
   ```bash
   bun test tests/agent/runtime-claude.test.ts
   ```
   Confirm no initialization error appears before test assertions begin.

**Broader applicability:** This pattern applies to any external SDK that
performs eager environment validation or I/O during construction — not just
Anthropic. If a new integration breaks tests at module load time (before the
first `test()` callback runs), lazy initialization is the first fix to reach for.

## Cross-Cutting Gotchas

**Execution order is non-deterministic across platforms.** Tests may pass
consistently on macOS or Windows but fail on CI (Linux) because Bun's file
discovery order differs. Always verify mock isolation and side-effect cleanup
by running `npm test` multiple times before declaring a fix stable.

**`beforeEach`/`afterEach` cannot undo process-level mock registrations.** If
a mock is registered via `mock.module()` at module scope, no test lifecycle
hook can restore the original module for other files in the same process.
The only reliable fix is process isolation (Procedure A).

**CI timing thresholds expose module-level timers.** A 5-second timer won't
surface locally if developers terminate the process manually, but CI's strict
exit detection catches it and marks the job failed even when all assertions
passed. The symptom — "all tests green, job failed" — is the diagnostic signal.

**The lazy initialization singleton persists for the Bun process lifetime.**
A `let client = null` or `private client?: Anthropic` pattern resets between
test *files* only if the module is re-required. Within a shared process run,
the singleton carries over. Use dependency injection or test-local instantiation
to reset between tests when clean state is required.

**`scripts/run-bun-tests.mjs` is the authoritative runner.** Direct `bun test`
invocations differ from `npm test` in file grouping and process count. When
diagnosing process-scope issues, consult `scripts/run-bun-tests.mjs` to
understand which files share a Bun process before assuming isolation.

**Prefer structural fixes over suppression.** Adding `--timeout` flags or
`process.exit()` calls to work around hangs hides the real problem. Always
trace the hang to its cause (module-level timer, open socket, pending mock)
and fix the root cause using the procedures above.

**Adding a new test file can reorganize chunk assignments and surface hidden state contamination.** Bun partitions test files into isolated chunks. Adding a new file may rebalance chunk assignments, causing previously-stable tests to move into chunks with different neighbors and expose latent state contamination. If CI failures appear immediately after adding a test file (with no logic changes), suspect chunk rebalancing before investigating test logic.

**`vitest` is a transitive dependency — declare it as a direct `devDependency`.** `vitest` enters the monorepo as a transitive dependency of `@cloudflare/vitest-pool-workers`. If that package is removed or its dependency tree changes, `vitest` imports in active test files will break silently. Declare `vitest` as a direct `devDependency` in the root `package.json` to make the dependency explicit and prevent accidental removal.

**A shared process can race `resolveMycoHome()` across async continuations, bleeding home boundaries.** A CI flake was initially suspected as a registry cache bleed but wasn't — mtime caches are path-keyed and cannot collide across homes. The real defect: of four grove-ownership backstop sites, `buildRegisteredRequestContext` in `packages/myco/src/grove/request-context.ts` re-resolves `resolveMycoHome()` without a cached value, so when a shared process handles concurrent requests/tests against different `MYCO_HOME` values, an async continuation can re-resolve mid-request and cross a home boundary. Cache the resolved home once and thread it through the request context explicitly instead of re-deriving it inside continuations.

**An interrupted bunfig swap leaves `bunfig.toml` pointed at jsdom.** `scripts/run-bun-tests.mjs`'s jsdom phase (`runPhase`, ~line 908) copies `bunfig.dom.toml` over the canonical `bunfig.toml` to run UI tests, then restores it afterward — a non-atomic swap. If the run is interrupted (Ctrl-C, addressing reviewer feedback mid-run, etc.) before restoration completes, the repo is silently stranded with `bunfig.toml` pointed at the jsdom preload. Node-target tests then fail with SDK init errors (e.g., OpenAI/Anthropic clients breaking under the jsdom environment) that look unrelated to the actual change. If node-side tests suddenly fail this way, check `git status bunfig.toml` first and restore it (`git checkout -- bunfig.toml`) before debugging further.

/**
 * Meta gate: keep tenancy out of the daemon's bootstrap-anchor vault.
 *
 * Background — the leak class this gate makes structurally impossible:
 *
 *   The global daemon synthesizes a fallback request context from its OWN
 *   bootstrap-anchor vault for EVERY request before handlers run. A handler
 *   that re-derives tenancy from a vault path instead of trusting the
 *   caller-supplied request context therefore acts against the *daemon's*
 *   project, not the *caller's* — a cross-tenant leak. We removed a whole
 *   class of these (cortex, skills, provider-secrets, notifications create
 *   gate, createMycoTools, and the residual daemon-dispatch / canopy-inject
 *   fallbacks).
 *
 * The single highest-signal, reliably-scannable anti-pattern is a call to
 * `resolveRequestContextForVault(...)` — the function that *synthesizes* a
 * tenancy context from a vault path — appearing OUTSIDE the request-context
 * module. Legitimately it belongs only inside
 * `packages/myco/src/tools/request-context.ts` (its definition + the
 * daemon-fallback synthesis site). A handful of single-tenant call sites
 * (agent-task gathers and vault-tool dep helpers that receive a
 * caller-supplied vaultDir, never the bootstrap anchor) are explicitly
 * allowlisted below. The request-path fallback idiom
 * `?? resolveRequestContextForVault(...)` is banned outright — it is the
 * exact shape of the leak and must never reappear, with NO allowlist.
 *
 * This is a static source scan (read files with node:fs; no daemon boot).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

// ---------------------------------------------------------------------------
// Why there is NO second gate on `?? bootstrapVaultDir` / `?? deps.vaultDir`
// ---------------------------------------------------------------------------
//
// A tempting companion gate would ban the
// `req.requestContext?.projectVaultDir ?? bootstrapVaultDir` fallback idiom.
// We deliberately DO NOT add it: at the time of writing there are ~12 such
// sites (daemon/main.ts, daemon/api/register-config-routes.ts,
// daemon/api/backup.ts, daemon/api/stats.ts, daemon/api/team-connect.ts) and
// they are LEGITIMATE inert vault passing — the resolved vaultDir is used to
// load merged config or to route to a database (which the daemon selects by
// `groveId` via `databaseForRequestContext`), NOT to derive tenancy. A
// line-based static scan cannot distinguish "this vaultDir later becomes a
// tenancy source" from "this vaultDir is config/db routing only" without
// data-flow analysis. A blanket ban would fail the build on correct code, so
// per the task's own guidance we rely on gate #1 below (the precise,
// high-signal `resolveRequestContextForVault` rule) plus the cross-tenant
// suite (tests/integration/multi-tenancy-invariant-e2e.test.ts) instead.

// ---------------------------------------------------------------------------
// Allowlist — the ONLY src files permitted to call
// `resolveRequestContextForVault(...)`.
//
// Adding to this list is a DELIBERATE, REVIEWED act: every entry must be a
// single-tenant site that synthesizes tenancy from a CALLER-SUPPLIED vault
// dir, never from the daemon's bootstrap-anchor vault. Request-path handlers
// (daemon/api/*, daemon/cortex.ts, mcp/*, daemon/event-dispatch.ts, …) must
// NOT appear here — they derive tenancy from `req.requestContext`/principal,
// which the daemon resolves and authorizes before the handler runs.
//
// Paths are repo-relative POSIX, matched against `packages/myco/src/**`.
const ALLOWLIST: readonly { file: string; why: string }[] = [
  {
    // Defines `resolveRequestContextForVault` and the daemon-fallback
    // synthesis it wraps. This is the home of the function.
    file: 'packages/myco/src/tools/request-context.ts',
    why: 'definition + the legitimate daemon-fallback synthesis site',
  },
  {
    // `handleMycoPlans` accepts `MycoRequestContext | string`; the string
    // arm is the legacy/CLI path where the caller hands its own vault dir.
    // Request transports always pass a resolved context, not a string.
    file: 'packages/myco/src/tools/plans.ts',
    why: 'legacy string-vaultDir arm of handleMycoPlans (callers pass a resolved context in the request path)',
  },
  {
    // Vault-tool dep helpers: synthesize ONLY from `deps.vaultDir` and only
    // when no `deps.requestContext` is present. `deps.vaultDir` is the
    // agent task\'s own project vault, set by the executor — single-tenant.
    file: 'packages/myco/src/agent/tools/types.ts',
    why: 'rowProjectId/projectScope dep helpers fall back to the agent task vaultDir, never the anchor',
  },
  {
    // Same single-tenant dep-helper pattern as types.ts, for canopy tools.
    file: 'packages/myco/src/agent/tools/canopy-tools.ts',
    why: 'resolveProjectId dep helper falls back to the agent task vaultDir, never the anchor',
  },
  {
    // Scheduled canopy-map gather: derives the project id from the task\'s
    // own projectRoot/vaultDir. Background sweep, single tenant by design.
    file: 'packages/myco/src/agent/instruction-builders.ts',
    why: 'gatherCanopyMapContext resolves the scheduled task\'s own project vault, never the anchor',
  },
  {
    // Internal notify() emitter: `vaultDir` is the project the caller is
    // emitting FOR (passed per-call), not the daemon anchor. Request-path
    // notification creation now resolves the principal and passes an
    // explicit projectId; this fallback only serves internal single-tenant
    // callers. Deliberately NOT on the `?? resolveRequestContextForVault`
    // idiom so the request-path ban stays absolute.
    file: 'packages/myco/src/notifications/notify.ts',
    why: 'notify() synthesizes from the caller-supplied project vaultDir, never the anchor',
  },
];

const ALLOWLISTED_FILES = new Set(ALLOWLIST.map((entry) => entry.file));

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'target', '.git']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Strip `//` line comments and `/* *\/` block comments so doc-comments and
 * explanatory prose that *mention* the patterns (e.g. this gate\'s own
 * description in notify.ts) are not mistaken for code. Deliberately simple:
 * the patterns we match never appear inside string literals in this codebase
 * (verified), so a full lexer is unnecessary. Block comments are blanked
 * line-by-line to preserve line numbers for diagnostics.
 */
function stripComments(source: string): string {
  // Remove block comments, preserving newlines so reported line numbers
  // stay accurate.
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  // Remove the trailing `//` comment on each line.
  return noBlock
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * A call expression to `resolveRequestContextForVault`. Matches the name
 * immediately followed by `(`, so `import { resolveRequestContextForVault }`
 * and bare type/comment references do not match.
 */
const CALL_PATTERN = /\bresolveRequestContextForVault\s*\(/;

/**
 * The request-path fallback idiom. `?? resolveRequestContextForVault(` — the
 * exact shape of the leak (trust the caller context, else synthesize from a
 * vault). Banned everywhere, no allowlist.
 */
const FALLBACK_IDIOM_PATTERN = /\?\?\s*resolveRequestContextForVault\s*\(/;

interface Violation {
  file: string;
  line: number;
  kind: 'call-outside-allowlist' | 'fallback-idiom';
  text: string;
}

function relPosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function scanSource(): Violation[] {
  const violations: Violation[] = [];
  for (const absPath of listSourceFiles(SRC_ROOT)) {
    const rel = relPosix(absPath);
    const code = stripComments(fs.readFileSync(absPath, 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      // Pattern 2: the fallback idiom is banned outright, allowlist or not.
      if (FALLBACK_IDIOM_PATTERN.test(line)) {
        violations.push({ file: rel, line: i + 1, kind: 'fallback-idiom', text: line.trim() });
      }
      // Pattern 1: any call outside the allowlist.
      if (CALL_PATTERN.test(line) && !ALLOWLISTED_FILES.has(rel)) {
        violations.push({ file: rel, line: i + 1, kind: 'call-outside-allowlist', text: line.trim() });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('no-anchor-as-tenancy meta gate', () => {
  it('scans a non-trivial number of source files (scan is wired, not silently empty)', () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no `resolveRequestContextForVault` call outside the allowlist, and no fallback idiom', () => {
    const violations = scanSource();
    const detail = violations
      .map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`)
      .join('\n');
    expect(violations.length, `tenant-scope leak anti-pattern reintroduced:\n${detail}\n\n`
      + 'A handler must derive tenancy from the caller\'s request context/principal, '
      + 'never by synthesizing it from a vault path. If this is a genuine '
      + 'single-tenant synthesis site (a caller-supplied project vaultDir, not the '
      + 'daemon bootstrap anchor), add it to ALLOWLIST with a justification — and '
      + 'never use the `?? resolveRequestContextForVault(...)` fallback idiom.').toBe(0);
  });

  it('every allowlisted file still exists and still calls resolveRequestContextForVault', () => {
    // Keeps the allowlist honest: a stale entry (the call was removed) should
    // be deleted so the list reflects reality and re-tightens the gate.
    for (const entry of ALLOWLIST) {
      if (entry.file === 'packages/myco/src/tools/request-context.ts') {
        // The definition file always references the name; assert existence only.
        expect(fs.existsSync(path.join(REPO_ROOT, entry.file)), `${entry.file} is missing`).toBe(true);
        continue;
      }
      const abs = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(abs), `allowlisted file is missing: ${entry.file}`).toBe(true);
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      expect(CALL_PATTERN.test(code), `stale allowlist entry — ${entry.file} no longer calls `
        + 'resolveRequestContextForVault; remove it from ALLOWLIST').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Self-test: prove the matchers actually catch the anti-patterns. Without
// this, a scan that silently matches nothing (a broken regex, a wrong path)
// would pass vacuously.
// ---------------------------------------------------------------------------

describe('no-anchor-as-tenancy matcher self-test', () => {
  it('CALL_PATTERN flags a planted call expression', () => {
    const sample = 'const ctx = resolveRequestContextForVault(vaultDir);';
    expect(CALL_PATTERN.test(sample)).toBe(true);
  });

  it('FALLBACK_IDIOM_PATTERN flags a planted `?? resolveRequestContextForVault(...)` fallback', () => {
    const sample = 'const ctx = req.requestContext ?? resolveRequestContextForVault(vaultDir);';
    expect(FALLBACK_IDIOM_PATTERN.test(sample)).toBe(true);
  });

  it('CALL_PATTERN ignores import statements and bare name references', () => {
    // An import binds the name but does not call it.
    expect(CALL_PATTERN.test('import { resolveRequestContextForVault } from \'./x.js\';')).toBe(false);
    // A bare reference with no following `(` is not a call.
    expect(CALL_PATTERN.test('const fn = resolveRequestContextForVault;')).toBe(false);
  });

  it('stripComments blanks a `//`-commented occurrence so it cannot false-positive', () => {
    const commented = '    // `?? resolveRequestContextForVault` idiom — described, not used\n';
    const stripped = stripComments(commented);
    expect(FALLBACK_IDIOM_PATTERN.test(stripped)).toBe(false);
    expect(CALL_PATTERN.test(stripped)).toBe(false);
  });

  it('stripComments blanks a block-comment occurrence while a real call survives', () => {
    const mixed = [
      '/**',
      ' * resolveRequestContextForVault(vaultDir) in a doc comment must not count.',
      ' */',
      'const ctx = resolveRequestContextForVault(real);',
    ].join('\n');
    const stripped = stripComments(mixed);
    const hits = stripped.split('\n').filter((l) => CALL_PATTERN.test(l));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('real');
  });

  it('the planted violation WOULD be caught if it lived in src (end-to-end matcher proof)', () => {
    // Simulate scanning a synthetic handler file and assert the scanner logic
    // (strip comments -> match) reports exactly the code line, not the comment.
    const syntheticHandler = [
      '// handler that re-derives tenancy from the anchor — the leak',
      'export function leakyHandler(req, vaultDir) {',
      '  const ctx = req.requestContext ?? resolveRequestContextForVault(vaultDir);',
      '  return ctx.projectId;',
      '}',
    ].join('\n');
    const code = stripComments(syntheticHandler);
    const flagged = code.split('\n').some(
      (line) => FALLBACK_IDIOM_PATTERN.test(line) || CALL_PATTERN.test(line),
    );
    expect(flagged).toBe(true);
  });
});

/**
 * Meta gate: keep raw SQLite execution OUT of the agent tools layer.
 *
 * Background — the erosion class this gate makes structurally impossible:
 *
 *   Agent tool handlers (`packages/myco/src/agent/tools/**`) are the harness's
 *   surface: small, frequently-added files that the agent calls during a run.
 *   The A6.5 + A7 work moved canopy-tools' inline SQL into the shared
 *   data-access layer (`db/queries/*`), so a tool now FORWARDS the db handle to
 *   a named query function instead of preparing/executing statements itself.
 *   Convention alone erodes — the next tool (or the next edit to an existing
 *   tool) silently re-introduces a `.prepare(` and the layering is gone. This
 *   static source scan FAILS the build the moment a tool file executes SQL
 *   directly, so the pattern can only be broken by a deliberate, reviewed
 *   allowlist entry (the ratchet below) — never by accident.
 *
 * The high-signal, reliably-scannable anti-patterns are the SQLite execution
 * calls themselves:
 *   - `.prepare(`      — `Database.prepare(...)`. Essentially nothing else in
 *                        this codebase uses `.prepare(`; very high signal.
 *   - `.transaction(`  — `Database.transaction(...)`. High signal.
 *   - `getDatabase().exec(` / `.prepare(` / `.transaction(` — the chained form
 *                        where a tool grabs the handle and executes inline.
 *
 * We deliberately DO NOT blanket-ban `.exec(`: `RegExp.prototype.exec(str)` is
 * legitimate and common in tool files (e.g. skill-contamination.ts uses
 * `FRONTMATTER_PATTERN.exec(content)`). `.exec(` is caught ONLY in the chained
 * `getDatabase().exec(` form, which is unambiguously a DB execution. A bare
 * `getDatabase()` call that forwards the handle to a query function
 * (`chargeDescribeAttempts(getDatabase(), projectId, paths)`) is ALLOWED — the
 * gate forbids EXECUTING SQL in the tool, not holding/forwarding the handle.
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
const TOOLS_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src', 'agent', 'tools');

// ---------------------------------------------------------------------------
// Allowlist — the ONLY tool files permitted to execute SQL inline.
//
// This list is a RATCHET: it can only shrink. Adding to it is a deliberate,
// reviewed act; the correct fix for a new violation is to move the SQL into
// `db/queries/*` and forward the db handle, NOT to add the file here. The
// "allowlist stays honest" guard below deletes any entry whose file no longer
// actually violates, so migrating a file re-tightens the gate automatically.
//
// Paths are repo-relative POSIX, matched against the scanned tool files.
// ---------------------------------------------------------------------------

const ALLOWLIST: readonly { file: string; why: string }[] = [
  {
    file: 'packages/myco/src/agent/tools/skill-tools.ts',
    why: 'pre-existing inline SQL (1 site); out of scope for the canopy-describe data-access migration; tracked for a follow-up migration',
  },
];

const ALLOWLISTED_FILES = new Set(ALLOWLIST.map((entry) => entry.file));

// ---------------------------------------------------------------------------
// Forbidden patterns — raw SQLite execution surfacing in a tool file.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  // SQLite `Database.prepare(...)`. High signal — nothing else here uses it.
  { name: 'prepare', pattern: /\.prepare\s*\(/ },
  // SQLite `Database.transaction(...)`.
  { name: 'transaction', pattern: /\.transaction\s*\(/ },
  // `getDatabase()` chained directly into an execution call. This is the ONLY
  // form that catches `.exec(` — a bare `RegExp.prototype.exec(str)` (no
  // `getDatabase()` immediately before it) does not match, and a bare
  // `getDatabase()` that forwards the handle (no chained `.exec/.prepare/
  // .transaction`) does not match either.
  { name: 'getDatabase-chained-exec', pattern: /getDatabase\s*\(\s*\)\s*\.\s*(?:prepare|transaction|exec)\s*\(/ },
];

/** Names of every forbidden pattern that matches a single line. */
function forbiddenMatches(line: string): string[] {
  return FORBIDDEN_PATTERNS.filter((p) => p.pattern.test(line)).map((p) => p.name);
}

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
 * Strip `//` line comments and block comments so doc-comments and explanatory
 * prose that *mention* the patterns (e.g. this gate's own description) are not
 * mistaken for code. Block comments are blanked line-by-line to preserve line
 * numbers for diagnostics.
 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return noBlock
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function relPosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

interface Violation {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function scanSource(): Violation[] {
  const violations: Violation[] = [];
  for (const absPath of listSourceFiles(TOOLS_ROOT)) {
    const rel = relPosix(absPath);
    const code = stripComments(fs.readFileSync(absPath, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const kind of forbiddenMatches(line)) {
        violations.push({ file: rel, line: i + 1, kind, text: line.trim() });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('no-raw-db-in-agent-tools meta gate', () => {
  it('scans a non-trivial number of tool source files (scan is wired, not silently empty)', () => {
    // If the path breaks (dir renamed/moved) this drops to ~0 and the gate
    // would pass vacuously. Surface that as a failure so it gets re-pointed.
    const files = listSourceFiles(TOOLS_ROOT);
    expect(files.length).toBeGreaterThan(8);
  });

  it('finds no raw SQLite execution in agent tools outside the allowlist', () => {
    const violations = scanSource().filter((v) => !ALLOWLISTED_FILES.has(v.file));
    const detail = violations
      .map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`)
      .join('\n');
    expect(violations.length, `raw SQL re-introduced into the agent tools layer:\n${detail}\n\n`
      + 'Agent tools must NOT execute SQLite directly (.prepare / .transaction / '
      + 'getDatabase().exec). Move the query into the data-access layer '
      + '(packages/myco/src/agent/db/queries/*) and have the tool forward the db '
      + 'handle to a named query function, exactly like canopy-tools.ts does after '
      + 'the A6.5/A7 migration. Do NOT add the file to ALLOWLIST unless this is a '
      + 'genuinely reviewed, deliberate exception.').toBe(0);
  });

  it('every allowlisted file still exists and STILL contains a forbidden pattern', () => {
    // Keeps the allowlist honest: once a file is migrated to db/queries it no
    // longer violates, so it must be removed from ALLOWLIST — which re-tightens
    // the gate. A stale entry fails here and forces its deletion.
    for (const entry of ALLOWLIST) {
      const abs = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(abs), `allowlisted file is missing: ${entry.file}`).toBe(true);
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      const stillViolates = code
        .split('\n')
        .some((line) => forbiddenMatches(line).length > 0);
      expect(stillViolates, `stale allowlist entry — ${entry.file} no longer executes raw `
        + 'SQL; remove it from ALLOWLIST so the gate re-tightens').toBe(true);
    }
  });

  it('canopy-tools.ts is NOT allowlisted (it was migrated by A6.5/A7 and must pass clean)', () => {
    expect(ALLOWLISTED_FILES.has('packages/myco/src/agent/tools/canopy-tools.ts')).toBe(false);
    const violations = scanSource().filter(
      (v) => v.file === 'packages/myco/src/agent/tools/canopy-tools.ts',
    );
    const detail = violations.map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`).join('\n');
    expect(violations.length, `canopy-tools.ts executes raw SQL — this is an A6.5/A7 migration `
      + `gap, not an allowlist candidate:\n${detail}`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Self-test: prove the matchers actually catch the anti-patterns AND ignore
// the legitimate non-matches. Without this, a scan that silently matches
// nothing (a broken regex, a wrong path) would pass vacuously.
// ---------------------------------------------------------------------------

describe('no-raw-db-in-agent-tools matcher self-test', () => {
  it('flags a planted `.prepare(` call (SQLite Database.prepare)', () => {
    expect(forbiddenMatches('const stmt = db.prepare("SELECT 1");')).toContain('prepare');
  });

  it('flags a planted `.transaction(` call (SQLite Database.transaction)', () => {
    expect(forbiddenMatches('db.transaction(() => { /* ... */ })();')).toContain('transaction');
  });

  it('flags the chained `getDatabase().exec(` form', () => {
    expect(forbiddenMatches('getDatabase().exec("PRAGMA foreign_keys = ON");'))
      .toContain('getDatabase-chained-exec');
  });

  it('flags the chained `getDatabase().prepare(` form', () => {
    expect(forbiddenMatches('const s = getDatabase().prepare("SELECT 1");'))
      .toContain('getDatabase-chained-exec');
  });

  it('does NOT flag a bare `getDatabase()` that forwards the handle to a query fn', () => {
    // The ALLOWED canopy-tools pattern: hold/forward the handle, do not execute.
    expect(forbiddenMatches('chargeDescribeAttempts(getDatabase(), projectId, paths);')).toEqual([]);
    expect(forbiddenMatches('const row = getCanopyEntryByPath(getDatabase(), projectId, p);')).toEqual([]);
  });

  it('does NOT flag a bare `RegExp.prototype.exec(str)` call', () => {
    // The exact reason `.exec(` is only caught in the chained form.
    expect(forbiddenMatches('const m = FRONTMATTER_PATTERN.exec(content);')).toEqual([]);
    expect(forbiddenMatches('const d = /^description\\s*:\\s*(.*)$/.exec(line.text);')).toEqual([]);
  });

  it('stripComments blanks a `//`-commented `.prepare(` so it cannot false-positive', () => {
    const commented = '    // db.prepare("SELECT 1") — described in a comment, not used\n';
    const stripped = stripComments(commented);
    expect(forbiddenMatches(stripped)).toEqual([]);
  });

  it('stripComments blanks a block-comment `.transaction(` while a real call survives', () => {
    const mixed = [
      '/**',
      ' * db.transaction(() => {}) in a doc comment must not count.',
      ' */',
      'db.transaction(() => { real(); })();',
    ].join('\n');
    const hits = stripComments(mixed)
      .split('\n')
      .filter((l) => forbiddenMatches(l).length > 0);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('real');
  });

  it('a planted violation in a synthetic tool-file string WOULD be caught (end-to-end matcher proof)', () => {
    const syntheticTool = [
      '// a tool that re-introduces inline SQL — the erosion this gate stops',
      'export function leakyTool(args) {',
      '  const stmt = getDatabase().prepare("UPDATE canopy SET x = ?");',
      '  return stmt.run(args.x);',
      '}',
    ].join('\n');
    const flagged = stripComments(syntheticTool)
      .split('\n')
      .some((line) => forbiddenMatches(line).length > 0);
    expect(flagged).toBe(true);
  });

  it('a clean synthetic tool-file (forward-the-handle only) is NOT caught', () => {
    const cleanTool = [
      '// the migrated shape: forward the handle, execute in db/queries/*',
      'export function describeTool(args) {',
      '  const row = getCanopyEntryByPath(getDatabase(), args.projectId, args.path);',
      '  const next = SOME_PATTERN.exec(row.text);',
      '  return next;',
      '}',
    ].join('\n');
    const flagged = stripComments(cleanTool)
      .split('\n')
      .some((line) => forbiddenMatches(line).length > 0);
    expect(flagged).toBe(false);
  });
});

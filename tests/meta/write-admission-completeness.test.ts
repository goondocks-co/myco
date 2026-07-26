/**
 * Meta gate W1: project write admission is unavoidable for project-scoped writes.
 *
 * The invariant (Project Write Admission spec, guarantee W1): no process may
 * write a project's durable state without consulting write admission — the
 * project lease surfaced through the pause API (`isProjectPaused`,
 * `pauseAwareShouldVisit`, `acquireProjectLease`, …). A writer that never
 * consults admission writes straight through a residency transition or a Grove
 * move, and everything it writes into the source Grove during the push window
 * is deleted unshipped by `deleteAfterAck`.
 *
 * What this gate enumerates:
 *
 *   1. **The `withDatabase` surface.** Every file with a real (comment-stripped)
 *      `withDatabase(` call site in `packages/myco/src` is a place where code
 *      obtains a scoped Grove DB handle. Each such file must be classified in
 *      `WRITE_ADMISSION_REGISTRY` below — gated, funnel, no-project-writes, or
 *      UNGATED. An unclassified file fails the build: a new writer cannot
 *      appear without declaring its admission story.
 *
 *   2. **Writers outside the funnel.** Some writers reach the Grove DB through
 *      the ambient `getDatabase()` singleton under someone else's
 *      `withDatabase` scope, so the surface scan cannot see them. The known
 *      ones are pinned by name in `UNGATED_WRITERS_OUTSIDE_FUNNEL`.
 *
 *   3. **The admission mechanisms themselves.** The classifications above lean
 *      on specific consult sites (the HTTP write gate in `daemon/server.ts`,
 *      the fan-out predicate `pauseAwareShouldVisit`, the lease acquisition in
 *      the transition owners). Those are pinned so a refactor cannot silently
 *      drop the mechanism a classification relies on.
 *
 * The `ungated` entries are a RATCHET — a shrink-only checklist of writers that
 * bypass admission today. Fixing a writer makes its entry stale (the
 * stays-honest check below fails), forcing the entry's removal and re-tightening
 * the gate. Adding a NEW `ungated` entry is a deliberate, reviewed act; the
 * correct fix for a new violation is to consult admission, not to grow the list.
 *
 * Known limitation, accepted: `scope-iteration.ts` is a funnel whose admission
 * is a caller-supplied `shouldVisit` predicate, and this scan is file-granular,
 * so a fan-out caller that omits `pauseAwareShouldVisit` is only caught when it
 * is pinned by name (see `session-maintenance`). The structural close for that
 * hole is the branded-admission `withDatabase` signature (write-admission
 * phases 4–6), at which point this gate's registry collapses into the compiler.
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

/** The funnel's own definition file — excluded from the caller surface. */
const WITH_DATABASE_DEFINITION = 'packages/myco/src/db/client.ts';

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/** A real `withDatabase(` invocation (imports have no trailing paren). */
const WITH_DATABASE_CALL = /\bwithDatabase\s*\(/;

/**
 * An admission consult: any call into the pause/lease API. `\(` excludes bare
 * import specifiers; `\b` keeps `pauseProject` from matching inside longer
 * identifiers.
 */
const ADMISSION_CONSULT = new RegExp(
  '\\b(?:isProjectPaused|isProjectPausedInGrove|pauseAwareShouldVisit'
  + '|pauseProject|acquireProjectLease|readProjectLease)\\s*\\(',
);

// ---------------------------------------------------------------------------
// Registry — every file on the `withDatabase` surface, classified.
//
//   gated              — the file itself consults admission and every one of
//                        its project-write paths sits behind the consult.
//                        Verified: the comment-stripped source must contain a
//                        consult call.
//   mixed              — the file contains a genuine consult AND at least one
//                        project-write path that does not go through it, named
//                        in `ungatedPaths`. Verified like `gated` (the consult
//                        must still exist), but the ungated paths CANNOT
//                        auto-stale at file granularity — flipping the entry to
//                        `gated` when they are fixed is a review obligation,
//                        which is why `ungatedPaths` must cite exact locations.
//   funnel             — a scoping primitive whose admission is its caller's
//                        obligation. Not independently verifiable; the `why`
//                        names the obligation.
//   no-project-writes  — the `withDatabase` scope performs no project-scoped
//                        row writes (reads, probes, grove-level-only rows).
//                        Declared with the evidence in `why`; reclassify if the
//                        file gains a project-scoped write.
//   ungated            — RATCHET. A known writer that bypasses admission.
//                        Verified STILL ungated: the file must contain zero
//                        consult calls. Once fixed, the stays-honest check
//                        fails and the entry must be removed (or flipped to
//                        `gated`), shrinking the list.
// ---------------------------------------------------------------------------

type Classification =
  | { kind: 'gated'; consult: string }
  | { kind: 'mixed'; consult: string; ungatedPaths: string }
  | { kind: 'funnel'; why: string }
  | { kind: 'no-project-writes'; why: string }
  | { kind: 'ungated'; why: string };

const WRITE_ADMISSION_REGISTRY: Record<string, Classification> = {
  'packages/myco/src/daemon/server.ts': {
    kind: 'gated',
    consult: 'isProjectPaused guards every write-method request (isWriteMethod + '
      + 'refusal) before the handler dispatch wraps in withDatabase',
  },
  'packages/myco/src/daemon/main.ts': {
    kind: 'mixed',
    consult: 'pauseAwareShouldVisit passed as shouldVisit to the registered-project '
      + 'canopy-populate fan-out',
    ungatedPaths: 'The boot-time stale-run sweeps write agent_runs with scope '
      + '{kind: \'all\'} — no project filter, no consult: the boot-DB sweep (near '
      + 'markRunningRunsInterrupted\'s first call) and the cross-Grove forEachGrove '
      + 'fan-out (jobName mark-stale-running-runs), which runs with no shouldVisitGrove. '
      + 'A project mid-transition at daemon restart has its agent_runs rows rewritten. '
      + 'Stage C: thread pause-awareness through both sweeps, then flip this to gated.',
  },
  'packages/myco/src/daemon/task-scheduling.ts': {
    kind: 'gated',
    consult: 'isProjectPausedInGrove inside the scheduler shouldVisit — paused projects are skipped before dispatch',
  },
  'packages/myco/src/daemon/scope-iteration.ts': {
    kind: 'funnel',
    why: 'forEachGrove/forEachRegisteredProject wrap fan-out bodies in withDatabase; '
      + 'admission is the caller\'s shouldVisit obligation (pauseAwareShouldVisit). '
      + 'A caller that omits it is an ungated writer — see the session-maintenance pin.',
  },
  'packages/myco/src/daemon/grove-pending-probe.ts': {
    kind: 'no-project-writes',
    why: 'countForGrove probes pending-work counts to hold the daemon awake; read-only.',
  },
  'packages/myco/src/daemon/api/maintenance.ts': {
    kind: 'ungated',
    why: 'handleReleaseProvenanceReconcile fans out grove-wide (forEachGrove, no '
      + 'per-project filter) and reconcileReleaseProvenance upserts project-scoped '
      + 'knowledge_release_state rows for every project in every Grove; the route '
      + 'carries no project in its path, so the per-project HTTP write gate never '
      + 'fires — the same action-scope shape as api/embedding.ts. The summary and '
      + 'pending-count paths in the same file are reads.',
  },
  'packages/myco/src/daemon/api/database.ts': {
    kind: 'no-project-writes',
    why: 'grove-wide DB maintenance (vacuum/optimize/integrity/backup) mutates no project-scoped rows.',
  },
  'packages/myco/src/daemon/grove-runtime-cache.ts': {
    kind: 'no-project-writes',
    why: 'seeds built-in agent/task definitions on Grove DB open — grove-level rows with no project_id.',
  },
  'packages/myco/src/daemon/reconciliation.ts': {
    kind: 'ungated',
    why: 'The buffer reconciler writes sessions/prompt_batches/activities from boot and '
      + 'drain-triggered passes that never cross the HTTP write gate. Writes land inside '
      + 'the residency push window and are deleted unshipped by deleteAfterAck.',
  },
  'packages/myco/src/daemon/api/embedding.ts': {
    kind: 'ungated',
    why: 'The grove-wide action path resolves its scope from the request body '
      + '(action-scope), so requestContext.projectId is absent and the per-project '
      + 'HTTP write gate never fires; embedding reindex/backfill writes project rows.',
  },
  'packages/myco/src/daemon/api/content-claims-materialize.ts': {
    kind: 'ungated',
    why: 'markPublished writes project-scoped content_claims rows with no admission consult.',
  },
  'packages/myco/src/tools/index.ts': {
    kind: 'ungated',
    why: 'The out-of-daemon front door (myco tool call) opens the Grove DB read-write '
      + 'and runs the migration chain with no ownership, pause, or residency check. '
      + 'Write-admission phase 6: it must read the lease and refuse, as the HTTP path does.',
  },
};

// ---------------------------------------------------------------------------
// Writers outside the funnel — reach the DB via ambient getDatabase() under a
// caller's withDatabase scope, so the surface scan cannot see them. RATCHET:
// same stays-honest rule as `ungated` (zero consult calls, else remove).
// ---------------------------------------------------------------------------

const UNGATED_WRITERS_OUTSIDE_FUNNEL: readonly { file: string; why: string }[] = [
  {
    file: 'packages/myco/src/daemon/jobs/session-maintenance.ts',
    why: 'Work-list SQL selects from sessions grove-wide with NO project predicate; the '
      + 'sweep completes sessions (driving miner writes) and cascade-deletes dead ones. '
      + 'Its power-job registration fans out per Grove with no pause-aware filter, so a '
      + 'project mid-residency-transition is still swept.',
  },
  {
    file: 'packages/myco/src/agent/executor.ts',
    why: 'A run dispatched before a transition writes agent_runs/turns/reports and task '
      + 'output straight through it: no admission consult anywhere in the file, and no '
      + 'abort path to stop an in-flight run.',
  },
  {
    file: 'packages/myco/src/tools/call-context.ts',
    why: 'The project_id-only pivot swaps the row scope with no registry, attach, '
      + 'journal, or lease lookup — a tool call re-targets a project an operation is '
      + 'actively moving.',
  },
];

// ---------------------------------------------------------------------------
// Mechanism pins — the consult sites the registry classifications lean on.
// If one of these disappears, the classification that names it is a lie.
// ---------------------------------------------------------------------------

const MECHANISM_PINS: readonly { file: string; pattern: RegExp; what: string }[] = [
  {
    file: 'packages/myco/src/daemon/server.ts',
    pattern: /isWriteMethod\s*\(/,
    what: 'the HTTP write-method discriminator feeding the central pause check',
  },
  {
    file: 'packages/myco/src/daemon/server.ts',
    pattern: /\bisProjectPaused\s*\(/,
    what: 'the central per-project pause consult on every HTTP write',
  },
  {
    file: 'packages/myco/src/grove/registry.ts',
    pattern: /export function pauseAwareShouldVisit/,
    what: 'the pause-aware fan-out predicate the background jobs rely on',
  },
  {
    file: 'packages/myco/src/daemon/power-jobs.ts',
    pattern: /pauseAwareShouldVisit\s*\(/,
    what: 'background fan-outs passing the pause-aware predicate',
  },
  {
    file: 'packages/myco/src/grove/move.ts',
    pattern: /\bpauseProject\s*\(/,
    what: 'grove move taking the project pause for its transition window',
  },
  {
    file: 'packages/myco/src/host/residency-transition.ts',
    pattern: /\bacquireProjectLease\s*\(/,
    what: 'residency transitions acquiring the project write lease',
  },
];

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
 * Strip `//` line comments and block comments so prose that mentions
 * `withDatabase(` or a consult call is not mistaken for code. Block comments
 * are blanked line-by-line to preserve line numbers for diagnostics.
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

function strippedSource(repoRelative: string): string {
  return stripComments(fs.readFileSync(path.join(REPO_ROOT, repoRelative), 'utf8'));
}

function consultsAdmission(repoRelative: string): boolean {
  return strippedSource(repoRelative)
    .split('\n')
    .some((line) => ADMISSION_CONSULT.test(line));
}

interface SurfaceEntry {
  file: string;
  sites: number;
}

/** Every file with ≥1 real `withDatabase(` call, with its site count. */
function scanWithDatabaseSurface(): SurfaceEntry[] {
  const out: SurfaceEntry[] = [];
  for (const absPath of listSourceFiles(SRC_ROOT)) {
    const rel = relPosix(absPath);
    if (rel === WITH_DATABASE_DEFINITION) continue;
    const sites = stripComments(fs.readFileSync(absPath, 'utf8'))
      .split('\n')
      .filter((line) => WITH_DATABASE_CALL.test(line))
      .length;
    if (sites > 0) out.push({ file: rel, sites });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('write-admission completeness meta gate (W1)', () => {
  const surface = scanWithDatabaseSurface();
  const surfaceFiles = new Set(surface.map((s) => s.file));

  it('scans a non-trivial surface (scan is wired, not silently empty)', () => {
    // If the path or matcher breaks this drops toward 0 and every check below
    // would pass vacuously. Surface that as a failure so it gets re-pointed.
    expect(surface.length).toBeGreaterThan(8);
    const totalSites = surface.reduce((n, s) => n + s.sites, 0);
    expect(totalSites).toBeGreaterThan(12);
  });

  it('every withDatabase caller is classified in the registry', () => {
    const unclassified = surface.filter((s) => !(s.file in WRITE_ADMISSION_REGISTRY));
    const detail = unclassified.map((s) => `  ${s.file} (${s.sites} site${s.sites === 1 ? '' : 's'})`).join('\n');
    expect(unclassified.length, `withDatabase caller(s) with no write-admission classification:\n${detail}\n\n`
      + 'Every file that obtains a scoped Grove DB handle must declare its admission '
      + 'story in WRITE_ADMISSION_REGISTRY (tests/meta/write-admission-completeness.test.ts). '
      + 'If the new code writes project-scoped state, it must consult admission '
      + '(isProjectPaused / pauseAwareShouldVisit / the project lease) — classify it '
      + '`gated` and point at the consult. Do NOT add an `ungated` entry unless this '
      + 'is a genuinely reviewed, deliberate exception.').toBe(0);
  });

  it('every registry entry still names a file on the surface (registry stays honest)', () => {
    const stale = Object.keys(WRITE_ADMISSION_REGISTRY).filter((file) => !surfaceFiles.has(file));
    expect(stale.length, `registry entries whose file no longer calls withDatabase:\n`
      + `  ${stale.join('\n  ')}\n\nRemove them so the registry matches the real surface.`).toBe(0);
  });

  it('every `gated` or `mixed` file really consults admission', () => {
    const liars = Object.entries(WRITE_ADMISSION_REGISTRY)
      .filter(([, c]) => c.kind === 'gated' || c.kind === 'mixed')
      .filter(([file]) => !consultsAdmission(file))
      .map(([file]) => file);
    expect(liars.length, `\`gated\`/\`mixed\` classification without an admission consult in the file:\n`
      + `  ${liars.join('\n  ')}\n\nEither restore the consult or reclassify honestly.`).toBe(0);
  });

  it('every `ungated` entry is STILL ungated (ratchet shrinks when a writer is fixed)', () => {
    const fixed = Object.entries(WRITE_ADMISSION_REGISTRY)
      .filter(([, c]) => c.kind === 'ungated')
      .filter(([file]) => consultsAdmission(file))
      .map(([file]) => file);
    expect(fixed.length, `stale \`ungated\` entries — these files now consult admission:\n`
      + `  ${fixed.join('\n  ')}\n\nFlip each to \`gated\` (naming the consult) so the ratchet re-tightens.`).toBe(0);
  });

  it('every pinned outside-funnel writer exists and is STILL ungated', () => {
    for (const entry of UNGATED_WRITERS_OUTSIDE_FUNNEL) {
      const abs = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(abs), `pinned writer is missing: ${entry.file} — if it was `
        + 'renamed or split, re-point the pin; if the writer is gone, remove the entry.').toBe(true);
      expect(consultsAdmission(entry.file), `stale pin — ${entry.file} now consults admission; `
        + 'remove it from UNGATED_WRITERS_OUTSIDE_FUNNEL so the checklist shrinks. '
        + '(If the fix landed at a different chokepoint instead — e.g. a pause-aware '
        + 'filter at the job registration — replace this pin with a mechanism pin on '
        + 'that chokepoint before removing it.)').toBe(false);
    }
  });

  it('the admission mechanisms the classifications lean on still exist', () => {
    for (const pin of MECHANISM_PINS) {
      const abs = path.join(REPO_ROOT, pin.file);
      expect(fs.existsSync(abs), `mechanism file is missing: ${pin.file} (${pin.what})`).toBe(true);
      const stripped = strippedSource(pin.file);
      expect(pin.pattern.test(stripped), `${pin.file} no longer contains ${String(pin.pattern)} — `
        + `${pin.what}. A registry classification leans on this; re-point it or fix the regression.`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Self-test: prove the matchers catch what they must and ignore what they
// must not. Without this, a broken regex would let every check pass vacuously.
// ---------------------------------------------------------------------------

describe('write-admission matcher self-test', () => {
  it('flags a real withDatabase call', () => {
    expect(WITH_DATABASE_CALL.test('return withDatabase(db, () => doWork());')).toBe(true);
    expect(WITH_DATABASE_CALL.test('  ? await withDatabase(requestDb, invokeHandler)')).toBe(true);
  });

  it('does NOT flag a withDatabase import or a mention without a call', () => {
    expect(WITH_DATABASE_CALL.test("import { withDatabase } from '@myco/db/client.js';")).toBe(false);
    expect(WITH_DATABASE_CALL.test('const helper = withDatabase;')).toBe(false);
  });

  it('flags each admission consult form', () => {
    expect(ADMISSION_CONSULT.test('const paused = isProjectPaused(projectId);')).toBe(true);
    expect(ADMISSION_CONSULT.test('const p = isProjectPausedInGrove(scope.grove.id, scope.projectId, mycoHome);')).toBe(true);
    expect(ADMISSION_CONSULT.test('shouldVisit: pauseAwareShouldVisit(mycoHome),')).toBe(true);
    expect(ADMISSION_CONSULT.test('pauseProject(projectId, owner, reason);')).toBe(true);
    expect(ADMISSION_CONSULT.test('const lease = acquireProjectLease(projectId, op, reason);')).toBe(true);
    expect(ADMISSION_CONSULT.test('const held = readProjectLease(projectId);')).toBe(true);
  });

  it('does NOT flag imports of the consult functions', () => {
    expect(ADMISSION_CONSULT.test("import { pauseAwareShouldVisit } from '../grove/registry.js';")).toBe(false);
    expect(ADMISSION_CONSULT.test("import { isProjectPaused, pauseProject } from './registry.js';")).toBe(false);
  });

  it('does NOT flag longer identifiers containing a consult name', () => {
    expect(ADMISSION_CONSULT.test('forceResumeProjectLease(projectId);')).toBe(false);
    expect(ADMISSION_CONSULT.test('releaseProjectLease(projectId, op);')).toBe(false);
  });

  it('stripComments blanks a commented withDatabase mention', () => {
    expect(WITH_DATABASE_CALL.test(stripComments('// wraps in withDatabase(db, fn) per Grove'))).toBe(false);
    const block = stripComments('/**\n * runs under withDatabase(groveDb, …)\n */\nreal();');
    expect(block.split('\n').some((l) => WITH_DATABASE_CALL.test(l))).toBe(false);
  });

  it('a planted ungated writer WOULD be caught by the completeness check (end-to-end)', () => {
    const synthetic = [
      "import { withDatabase } from '@myco/db/client.js';",
      'export function sneakyJob(db: Database) {',
      '  return withDatabase(db, () => insertRows());',
      '}',
    ].join('\n');
    const sites = stripComments(synthetic).split('\n').filter((l) => WITH_DATABASE_CALL.test(l));
    expect(sites.length).toBe(1);
    expect(stripComments(synthetic).split('\n').some((l) => ADMISSION_CONSULT.test(l))).toBe(false);
  });
});

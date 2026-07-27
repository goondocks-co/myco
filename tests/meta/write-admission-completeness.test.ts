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
  + '|pauseProject|acquireProjectLease|readProjectLease'
  // The tool surface's consult. It wraps readProjectLease rather than
  // calling the pause API directly, so the raw-name list above cannot see
  // it — and a `gated` tools file would read as a liar without this.
  + '|assertProjectAdmitsToolWrite)\\s*\\(',
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
//   gated-upstream     — the file itself contains no consult because every one
//                        of its project-write paths enters through a named
//                        upstream funnel that consults for it. Verified: the
//                        NAMED funnel must consult admission (and must carry a
//                        mechanism pin below). Like `mixed`, "every path really
//                        does enter through that funnel" is a review
//                        obligation the scan cannot check — so the funnel must
//                        be a single narrow entry point, not a convention.
//   funnel             — a scoping primitive whose admission is its caller's
//                        obligation. Not independently verifiable; the `why`
//                        names the obligation.
//   no-project-writes  — the `withDatabase` scope performs no project-scoped
//                        row writes (reads, probes, grove-level-only rows).
//                        Declared with the evidence in `why`; reclassify if the
//                        file gains a project-scoped write.
//   ungated            — RATCHET, currently EMPTY. A known writer that bypasses admission.
//                        Verified STILL ungated: the file must contain zero
//                        consult calls. Once fixed, the stays-honest check
//                        fails and the entry must be removed (or flipped to
//                        `gated`), shrinking the list.
// ---------------------------------------------------------------------------

type Classification =
  | { kind: 'gated'; consult: string }
  | { kind: 'gated-upstream'; funnel: string; consult: string }
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
    kind: 'gated',
    consult: 'pauseAwareShouldVisit passed as shouldVisit to the registered-project '
      + 'canopy-populate fan-out; and leaseHeldProjectIdsForSweep (isProjectPaused over '
      + 'the sweeps\' candidate project ids) feeding excludeProjectIds to BOTH boot '
      + 'stale-run sweeps — the boot-DB one and the cross-Grove mark-stale-running-runs '
      + 'fan-out. Exclusions are derived from the agent_runs rows rather than the Grove '
      + 'registry because a project mid-residency-transition is deregistered from every '
      + 'Grove while its lease is held.',
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
    kind: 'gated',
    consult: 'ONE writer, one mechanism. handleReleaseProvenanceReconcile does NOT go '
      + 'through runScopedAction (it ignores the request and fans out forEachGrove '
      + 'directly), so it consults isProjectPausedInGrove per project inside its own '
      + 'loop and skips held projects — safe rather than lossy, since reconcile is '
      + 'idempotent and re-derivable. Every OTHER path in the file is a read and needs '
      + 'no gate: handleGroveMaintenance is a per-Grove summary (buildGroveSummary — '
      + 'file stats, counts, listRegisteredProjects) and does NOT route through '
      + 'runScopedAction, as an earlier revision of this entry wrongly claimed; '
      + 'handleSummary and the pending-count paths are likewise reads.',
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
    kind: 'gated',
    consult: 'isProjectPausedInGrove inside groveScopeForDir — the single chokepoint '
      + 'every reconciler path already passes through to obtain its DB binding. A held '
      + 'lease resolves to the DirScope variant `paused`, so the discriminated union '
      + 'makes the compiler force each consumer to handle it. All three DEFER rather '
      + 'than discard: reconcileSession returns `deferred` (buffer left byte-intact and '
      + 'unmarked), runDrainPass contributes no candidates for the dir, and '
      + 'cleanBufferDirs skips stale-deletion, quarantine AND the quarantine prune.',
  },
  'packages/myco/src/daemon/api/embedding.ts': {
    kind: 'gated-upstream',
    funnel: 'packages/myco/src/daemon/api/scoped-dispatch.ts',
    consult: 'All four route handlers dispatch through runScopedAction, whose '
      + 'checkActionWriteAdmission consults admission before the run callback fires. '
      + 'This endpoint leaves dataPlane at its `grove-wide` default, which is '
      + 'load-bearing rather than incidental: the `project` scope arm is accepted but '
      + 'NOT narrowed — the same Grove-wide callback runs, and clearAllEmbedded / '
      + 'getUnembedded / the orphan sweeps carry no project predicate, so a '
      + 'project-scoped REQUEST is a Grove-wide WRITE. Under `grove-wide`, a `project` '
      + 'scope is admitted by the Grove rule (any leased project in the Grove refuses '
      + 'it), which is what closes that hole. NOTE the four `handleEmbedding*` '
      + 'functions exported above the route handlers are test-only and bypass this '
      + 'funnel by construction — they must not gain a production caller.',
  },
  'packages/myco/src/daemon/api/content-claims-materialize.ts': {
    kind: 'gated',
    consult: 'isProjectPaused in createContentClaimMaterializeHandler, ahead of the '
      + 'local/attached branch so both are covered. The consult cannot live at the HTTP '
      + 'write gate because this route resolves its project from the BODY '
      + '(resolveMemberProjectContext), not the path, so requestContext.projectId does '
      + 'not identify it.',
  },
  'packages/myco/src/tools/index.ts': {
    kind: 'gated',
    consult: 'assertProjectAdmitsToolWrite in callTool, consulted on the EFFECTIVE context '
      + '(after effectiveContextFor) so it covers a pivoted call as well as the base one. '
      + 'This gate is load-bearing for a non-obvious reason: `/mcp` is a RAW route, and '
      + 'DaemonServer.handleRequest dispatches raw routes and RETURNS before the central '
      + 'per-project pause gate — so every tool call (CLI, MCP, overlay) reaches the shared '
      + 'handlers without ever crossing it. NOTE the older framing "the out-of-daemon front '
      + 'door" is stale: decision-14e572a3 made `myco tool call` a thin MCP client of the '
      + 'local daemon, so these calls run INSIDE the daemon. '
      + 'Gated per (tool, op) rather than per tool: myco_plans and myco_spores are '
      + 'write-capable as a whole while most of their ops are reads, and refusing the tool '
      + 'would blind an agent to its own plans and spores for the length of a transition '
      + 'with no safety gain. Reads are deliberately admitted, matching the HTTP gate. '
      + 'The (tool, op) table is held complete against the schema enums by '
      + 'tests/meta/tool-op-classification.test.ts, and isMutatingToolCall fails closed on '
      + 'an unknown tool or op. runWithRequestDatabase additionally refuses to run the '
      + 'migration chain against a leased project, but that branch is NOT what makes this '
      + 'file safe — it is unreachable from either production wiring (both pass '
      + 'resolveDatabase) and guards only a re-added out-of-daemon caller.',
  },
};

// ---------------------------------------------------------------------------
// Writers outside the funnel — reach the DB via ambient getDatabase() under a
// caller's withDatabase scope, so the surface scan cannot see them. RATCHET:
// same stays-honest rule as `ungated` (zero consult calls, else remove).
// ---------------------------------------------------------------------------

// Empty as of the Stage C writer fixes — every previously-pinned writer now
// consults admission and is held by a mechanism pin below instead. New
// entries require the same review bar as a registry `ungated` entry.
const UNGATED_WRITERS_OUTSIDE_FUNNEL: readonly { file: string; why: string }[] = [];

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
  {
    file: 'packages/myco/src/daemon/jobs/session-maintenance.ts',
    pattern: /\bisProjectPaused\s*\(/,
    what: 'the session sweep skipping projects whose write lease is held',
  },
  {
    file: 'packages/myco/src/tools/call-context.ts',
    pattern: /\bassertProjectAdmitsToolWrite\s*\(/,
    what: 'the tool-call project pivot refusing a project whose write lease is held. '
      + 'It delegates to the shared tool-surface helper rather than reading the lease '
      + 'itself, so one condition cannot grow two different refusal messages',
  },
  {
    file: 'packages/myco/src/tools/lease-admission.ts',
    pattern: /export function assertProjectAdmitsToolWrite/,
    what: 'the tool-surface admission consult itself — the single refusal shared by the '
      + 'front door and the pivot',
  },

  {
    file: 'packages/myco/src/agent/executor.ts',
    pattern: /\bisProjectPaused\s*\(/,
    what: 'run dispatch and resume refusing a project whose write lease is held',
  },
  {
    file: 'packages/myco/src/daemon/api/scoped-dispatch.ts',
    pattern: /function checkActionWriteAdmission/,
    what: 'the action-scope funnel gate — the only admission consult for endpoints '
      + 'whose scope comes from the request body, where the per-project HTTP gate cannot fire',
  },
  {
    file: 'packages/myco/src/daemon/api/scoped-dispatch.ts',
    pattern: /options\.dataPlane\s*\?\?\s*'grove-wide'/,
    what: 'the fail-closed dataPlane default — an endpoint that does not declare its '
      + 'write breadth is admitted under the Grove rule, so a project-scoped request to '
      + 'a Grove-wide endpoint cannot slip past on the named project alone',
  },
  {
    file: 'packages/myco/src/grove/project-lease.ts',
    pattern: /export function listWriteBlockedProjectIds/,
    what: 'the admission-side lease listing that counts UNREADABLE records as held (G4), '
      + 'unlike listProjectLeases which drops them',
  },
  {
    file: 'packages/myco/src/daemon/reconciliation.ts',
    pattern: /type RunnableScope = \{ bind:/,
    what: 'the runnable-vs-refused split in DirScope. Pinning `kind: \'paused\'` alone '
      + 'was insufficient: it proved the variant was DECLARED, not that anything '
      + 'branched on it — with the consumers on a `kind === \'scoped\' ? … : …` ternary, '
      + 'deleting a paused guard compiled clean and ran the pass against the ambient '
      + 'binding. Only the refusals lacking `bind` makes a dropped guard a type error',
  },
  {
    file: 'packages/myco/src/daemon/main.ts',
    pattern: /function leaseHeldProjectIdsForSweep/,
    what: 'the boot stale-run sweeps\' exclusion set, derived from candidate rows rather '
      + 'than the Grove registry',
  },
  {
    file: 'packages/myco/src/db/queries/runs.ts',
    pattern: /function appendProjectExclusion/,
    what: 'the NOT IN guard the boot sweeps\' exclusions are applied through',
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

  it('every `gated-upstream` entry names a funnel that really consults, and pins it', () => {
    const pinnedFiles = new Set(MECHANISM_PINS.map((p) => p.file));
    for (const [file, classification] of Object.entries(WRITE_ADMISSION_REGISTRY)) {
      if (classification.kind !== 'gated-upstream') continue;
      const funnel = classification.funnel;
      expect(fs.existsSync(path.join(REPO_ROOT, funnel)),
        `${file} is classified gated-upstream but its funnel ${funnel} does not exist.`).toBe(true);
      expect(consultsAdmission(funnel),
        `${file} is classified gated-upstream via ${funnel}, but that funnel contains no `
        + 'admission consult. Either the gate was removed or the classification is a lie.').toBe(true);
      // The funnel must be pinned too: without a pin, a refactor could move
      // the consult out of it and only this indirect check would notice.
      expect(pinnedFiles.has(funnel),
        `${file} leans on ${funnel} for admission, but ${funnel} has no MECHANISM_PINS entry. `
        + 'Pin the consult so a refactor cannot silently drop it.').toBe(true);
    }
  });

  it('a `gated-upstream` file does NOT also need an in-file consult (classification is distinct)', () => {
    // Guards against someone "fixing" a gated-upstream entry by flipping it to
    // `gated`, which the in-file check would then fail — the two kinds are not
    // interchangeable and this records why.
    const upstream = Object.entries(WRITE_ADMISSION_REGISTRY)
      .filter(([, c]) => c.kind === 'gated-upstream')
      .map(([file]) => file);
    expect(upstream.length).toBeGreaterThan(0);
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

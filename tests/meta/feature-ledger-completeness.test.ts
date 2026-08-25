/**
 * Meta gate: every 1.4 surface carries an explicit 2.0 disposition AND an owning surface.
 *
 * `docs/architecture/myco-2.0.md` §7 is the feature-preservation ledger for the 2.0
 * release. Its governing rule is that replacing infrastructure is never authority to
 * lose a feature: every capability gets KEEP / REPLACE / DROP and a named owner.
 *
 * A ledger with no gate goes stale the first time someone adds a CLI command — and the
 * failure is silent, because a capability nobody enumerated is dropped by default rather
 * than by decision. That is the exact defect the ledger exists to answer.
 *
 * This gate statically scans the six registries that define the 1.4 surface and asserts
 * every token appears in a ledger row with BOTH a disposition and an owning surface,
 * failing by name when either is missing:
 *
 *   - CLI commands   — `cmd === '<name>'` / `case '<name>':` in `packages/myco/src/cli.ts`
 *   - Dashboard routes — `path="<literal>"` in `packages/myco/ui/src/App.tsx`
 *   - MCP tools      — `TOOL_* = 'myco_*'` in `packages/myco/src/tools/definitions.ts`
 *   - Agent tasks    — YAML filenames under `src/agent/definitions/tasks/`
 *   - Scheduled jobs — `POWER_JOB_NAMES` values in `src/constants/power-jobs.ts`
 *   - Data classes   — `CREATE TABLE` names under `packages/myco/src/db/`
 *   - Config leaves  — every leaf the `MycoConfigSchema` DECLARES (§7.8)
 *
 * The SURFACE half matters most. A row with a disposition but no surface is how a
 * capability ends up owned by nobody — the planning defect of the same class as a
 * property with no gate.
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/route-stamp-completeness.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredLeafPaths } from '@myco/config/declared-leaves.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const LEDGER_PATH = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

/** Dispositions the ledger may assign. */
const DISPOSITIONS = new Set(['KEEP', 'REPLACE', 'DROP']);

/**
 * Config leaves whose children are dynamic — a record or array whose keys are not
 * enumerable from a defaulted schema. §7.8 classifies each block whole, so a leaf
 * beneath one is covered by its prefix.
 */
const DYNAMIC_CONFIG_BLOCKS = ['agent.tasks', 'notifications.domains', 'symbionts', 'release_provenance.package_map'];

/** The closed set of owning surfaces (§4). `—` is legal only alongside DROP. */
const SURFACES = new Set(['M', 'MS', 'Core', 'W', 'C', 'UI', 'MCP']);

/** CLI tokens that are flag aliases, not commands. */
const CLI_FLAG_ALIASES = new Set(['--help', '-h', '--version', '-v']);

const read = (p: string): string => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Ledger parse
// ---------------------------------------------------------------------------

interface LedgerRow {
  token: string;
  disposition: string;
  surfaces: string[];
  raw: string;
}

/**
 * Parse every §7 table row. A row's identity is the FIRST backticked token in its
 * first cell, so trailing qualifiers ("`settings` (project-scoped)") are cosmetic.
 * The disposition is cell 2; the surface cell is the first following cell whose
 * content is `—` or a comma-separated list drawn entirely from SURFACES — which
 * tolerates §7.6 carrying an extra Migration column without a second parser.
 */
function parseLedger(): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of read(LEDGER_PATH).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const token = cells[0].match(/`([^`]+)`/)?.[1];
    if (!token) continue;

    const disposition = cells[1];
    if (!DISPOSITIONS.has(disposition)) continue;

    let surfaces: string[] | null = null;
    for (const cell of cells.slice(2)) {
      if (cell === '—') { surfaces = []; break; }
      const parts = cell.split(',').map((s) => s.trim());
      if (parts.length > 0 && parts.every((s) => SURFACES.has(s))) { surfaces = parts; break; }
    }
    if (surfaces === null) continue;

    rows.push({ token, disposition, surfaces, raw: line });
  }
  return rows;
}

const LEDGER = parseLedger();
const BY_TOKEN = new Map(LEDGER.map((r) => [r.token, r]));

// ---------------------------------------------------------------------------
// Registry scans
// ---------------------------------------------------------------------------

function cliCommands(): string[] {
  const src = read(path.join(SRC_ROOT, 'cli.ts'));
  const found = new Set<string>();
  for (const m of src.matchAll(/cmd === '([^']+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/case '([^']+)':/g)) found.add(m[1]);
  return [...found].filter((c) => !CLI_FLAG_ALIASES.has(c)).sort();
}

function dashboardRoutes(): string[] {
  const src = read(path.join(REPO_ROOT, 'packages', 'myco', 'ui', 'src', 'App.tsx'));
  return [...new Set([...src.matchAll(/path="([^"]*)"/g)].map((m) => m[1]))].sort();
}

function mcpTools(): string[] {
  const src = read(path.join(SRC_ROOT, 'tools', 'definitions.ts'));
  return [...new Set([...src.matchAll(/^export const TOOL_[A-Z_]+ = '(myco_[a-z_]+)';/gm)].map((m) => m[1]))].sort();
}

function agentTasks(): string[] {
  const dir = path.join(SRC_ROOT, 'agent', 'definitions', 'tasks');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
}

function scheduledJobs(): string[] {
  const src = read(path.join(SRC_ROOT, 'constants', 'power-jobs.ts'));
  const body = src.slice(src.indexOf('POWER_JOB_NAMES = '));
  return [...new Set([...body.matchAll(/^\s+[A-Z_0-9]+: '([a-z-]+)',/gm)].map((m) => m[1]))].sort();
}

/**
 * `migrations.ts` is the historical migration chain, not a description of the live
 * schema. It creates transient rebuild scaffolding (`activities_v43`,
 * `agent_state_v40` — create-copy-drop-rename steps) and tables since dropped
 * (`agent_run_evaluations`), none of which are data classes the ledger disposes of.
 * Scanning it would demand ledger rows for tables no vault carries. The live schema
 * files are the registry; a genuinely new table lands there too, so the exclusion
 * cannot hide one.
 */
const MIGRATION_CHAIN = 'migrations.ts';

function dataClasses(): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== MIGRATION_CHAIN) {
        for (const m of read(full).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(SRC_ROOT, 'db'));
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Every leaf of the defaulted config schema, with dynamic blocks collapsed to the
 * prefix §7.8 classifies them under.
 *
 * Imported rather than source-scanned: a regex over `schema.ts` would miss a leaf
 * added through a shared sub-schema, which is the failure the ledger exists to
 * prevent.
 *
 * DECLARED, not defaulted. A leaf declared `.optional()` never appears in a parsed
 * config, and the optional ones are `agent.provider.base_url`, `agent.provider.type`
 * and `embedding.base_url` — the endpoints a Deployment's own credential is sent to.
 * A coverage gate reading a defaulted parse is blind precisely where coverage
 * matters most.
 */
function configLeaves(): string[] {
  const out = new Set<string>();
  for (const leaf of declaredLeafPaths()) {
    const block = DYNAMIC_CONFIG_BLOCKS.find((b) => leaf === b || leaf.startsWith(`${b}.`));
    out.add(block ?? leaf);
  }
  for (const b of DYNAMIC_CONFIG_BLOCKS) out.add(b);
  return [...out].sort();
}

const REGISTRIES: Array<[string, () => string[]]> = [
  ['CLI commands', cliCommands],
  ['dashboard routes', dashboardRoutes],
  ['MCP tools', mcpTools],
  ['agent tasks', agentTasks],
  ['scheduled jobs', scheduledJobs],
  ['data classes', dataClasses],
  ['config leaves', configLeaves],
];

describe('feature-preservation ledger completeness', () => {
  it('parses a non-trivial ledger (guards against a silently empty parse)', () => {
    expect(LEDGER.length).toBeGreaterThan(100);
  });

  for (const [label, scan] of REGISTRIES) {
    it(`every 1.4 ${label} entry carries a disposition and an owning surface`, () => {
      const tokens = scan();
      expect(tokens.length).toBeGreaterThan(0);

      const missing = tokens.filter((t) => !BY_TOKEN.has(t));
      expect(
        missing,
        `${label} with no ledger row in docs/architecture/myco-2.0.md §7 — every capability needs an explicit KEEP/REPLACE/DROP and an owning surface: ${missing.join(', ')}`,
      ).toEqual([]);

      const unowned = tokens.filter((t) => {
        const row = BY_TOKEN.get(t)!;
        return row.disposition !== 'DROP' && row.surfaces.length === 0;
      });
      expect(
        unowned,
        `${label} kept or replaced with NO owning surface — this is how a capability ends up owned by nobody: ${unowned.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('no DROP row claims an owning surface', () => {
    const contradictory = LEDGER.filter((r) => r.disposition === 'DROP' && r.surfaces.length > 0);
    expect(
      contradictory.map((r) => r.token),
      'a DROPped capability cannot have an owner; either it survives (KEEP/REPLACE) or the surface is wrong',
    ).toEqual([]);
  });

  it('no ledger row names a surface outside the closed set', () => {
    // parseLedger only admits rows whose surface cell is drawn from SURFACES, so a
    // typo'd surface makes the row unparseable and the token reads as MISSING above.
    // This asserts the inverse directly: every registry token resolved to a row.
    const allTokens = REGISTRIES.flatMap(([, scan]) => scan());
    const unresolved = allTokens.filter((t) => !BY_TOKEN.has(t));
    expect(unresolved).toEqual([]);
  });
});

import { COMMANDS } from '@myco/cli/command-registry.js';
/**
 * Every frozen 1.4 registry token and live 2.0 capability has an explicit
 * KEEP, REPLACE or DROP disposition and an owner in the architecture ledger.
 * CLI tokens come from the dispatch registry, including compatibility entries.
 * Live KEEP/NEW rows must be produced by a live registry. Retired tokens remain
 * frozen so deleting an implementation cannot silently delete its capability.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseLedger, REPO_ROOT } from '../helpers/ledger.ts';
import { RETAINED_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import { SERVED_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { SERVER_JOBS, TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '@myco-server-worker/core/settings.js';
import { MACHINE_LEAVES } from '@myco-server-worker/core/machine-settings.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';

const { DEFAULT_APPEARANCE: viewerAppearance } = await import(path.join(REPO_ROOT, 'packages/myco-server/ui/src/lib/appearance-values.ts'));

const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/**
 * Config leaves whose children are dynamic — a record or array whose keys are not
 * enumerable from a defaulted schema. §7.8 classifies each block whole, so a leaf
 * beneath one is covered by its prefix.
 */
const DYNAMIC_CONFIG_BLOCKS = ['agent.tasks', 'notifications.domains', 'symbionts', 'release_provenance.package_map'];


const read = (p: string): string => fs.readFileSync(p, 'utf8');

const LEDGER = parseLedger();
/** The rows of each §7 section, by token. */
const BY_SECTION = new Map<string, Map<string, (typeof LEDGER)[number]>>();
for (const row of LEDGER) {
  if (!BY_SECTION.has(row.section)) BY_SECTION.set(row.section, new Map());
  BY_SECTION.get(row.section)!.set(row.token, row);
}
const rowIn = (section: string, token: string) => BY_SECTION.get(section)?.get(token);

// ---------------------------------------------------------------------------
// Registry scans
// ---------------------------------------------------------------------------

function cliCommands(): string[] {
  return Object.keys(COMMANDS).filter(name => !name.startsWith('-')).sort();
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

/** One spelling of a table name for both the CREATE and the DROP scan, so the two sets are drawn from the same tokens. */
const TABLE_NAME = '([a-z_][a-z0-9_]*)';

/**
 * Every schema directory in the monorepo: `packages/<pkg>/src/db/` wherever it
 * exists. A package that gains a schema is scanned with no edit here.
 */
function schemaDirs(): string[] {
  const packages = path.join(REPO_ROOT, 'packages');
  return fs.readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packages, entry.name, 'src', 'db'))
    .filter((dir) => fs.existsSync(dir))
    .sort();
}

/**
 * The tables the live schemas create and keep. A table a schema file DROPs after
 * it last creates it is scaffolding of a migration step — a grammar probe or a
 * holding table created and dropped inside one step — and is no data class; one
 * the file creates again after its last DROP is rebuilt and stays. The exclusion
 * reads the statements and their order, never a name pattern.
 */
function dataClasses(): string[] {
  const created = new Set<string>();
  const dropped = new Set<string>();
  const collect = (src: string): void => {
    for (const m of src.matchAll(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${TABLE_NAME}`, 'g'))) created.add(m[1]);
    for (const m of src.matchAll(new RegExp(`DROP TABLE (?:IF EXISTS )?${TABLE_NAME}`, 'g'))) {
      if (!new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${m[1]}\\b`).test(src.slice(m.index))) dropped.add(m[1]);
    }
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== MIGRATION_CHAIN) {
        collect(read(full));
      }
    }
  };
  for (const dir of schemaDirs()) walk(dir);
  collect(SCHEMA_DDL.join('\n'));
  const frozen = read(path.join(REPO_ROOT, 'tests/fixtures/legacy/vault-v76.sql'));
  for (const m of frozen.matchAll(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${TABLE_NAME}`, 'g'))) created.add(m[1]);
  return [...created].filter((t) => !dropped.has(t)).sort();
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * The 2.0 dashboard's route table, the one `App.tsx` renders. It is the dashboard's own TSX, which the tests typecheck
 * program does not compile, so it is loaded by path and read for its paths alone.
 */
const ROUTE_TABLE = path.join(REPO_ROOT, 'packages', 'myco-server', 'ui', 'src', 'routes', 'table.tsx');

/** A route tree as the table holds it: a path, perhaps, and children, perhaps. */
interface RouteNode { path?: string; children?: RouteNode[] }

/** The table's `routePaths`, read only while the table is there; a table that moved reports through the registry's source. */
const routePaths: ((routes?: RouteNode[]) => string[]) | null = fs.existsSync(ROUTE_TABLE)
  ? ((await import(ROUTE_TABLE)) as { routePaths: (routes?: RouteNode[]) => string[] }).routePaths
  : null;

const DECLARED_LEAVES = path.join(SRC_ROOT, 'config', 'declared-leaves.ts');

/** The 1.4 config schema's declared leaves, read only while the schema is there to read. */
const declaredLeafPaths: (() => string[]) | null = fs.existsSync(DECLARED_LEAVES)
  ? ((await import(DECLARED_LEAVES)) as { declaredLeafPaths: () => string[] }).declaredLeafPaths
  : null;

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
  for (const leaf of declaredLeafPaths!()) {
    const block = DYNAMIC_CONFIG_BLOCKS.find((b) => leaf === b || leaf.startsWith(`${b}.`));
    out.add(block ?? leaf);
  }
  for (const b of DYNAMIC_CONFIG_BLOCKS) out.add(b);
  return [...out].sort();
}

/**
 * A registry: what it is called, the repo path that holds it, the §7 section its rows sit in, and how its tokens are
 * read. `answers` marks the registry whose tokens are what 2.0 answers at in its section: each of its tokens sits on a
 * KEEP or NEW row, and every KEEP or NEW row of its section is one of its tokens.
 */
interface Registry {
  label: string;
  source: string;
  section: string;
  scan: () => string[];
  answers?: true;
}

const REGISTRIES: readonly Registry[] = [
  { label: 'CLI commands', source: 'packages/myco/src/cli/command-registry.ts', section: '7.1', scan: cliCommands },
  { label: 'dashboard routes', source: 'packages/myco/ui/src/App.tsx', section: '7.2', scan: dashboardRoutes },
  { label: 'MCP tools', source: 'packages/myco/src/tools/definitions.ts', section: '7.3', scan: mcpTools },
  { label: 'agent tasks', source: 'packages/myco/src/agent/definitions/tasks', section: '7.4', scan: agentTasks },
  { label: 'scheduled jobs', source: 'packages/myco/src/constants/power-jobs.ts', section: '7.5', scan: scheduledJobs },
  { label: 'data classes', source: 'packages/myco-server/src/db', section: '7.6', scan: dataClasses },
  { label: 'config leaves', source: 'packages/myco/src/config/declared-leaves.ts', section: '7.8', scan: configLeaves },
  { label: '2.0 dashboard routes', source: 'packages/myco-server/ui/src/routes/table.tsx', section: '7.2', answers: true, scan: () => [...new Set(routePaths!())].sort() },
  { label: 'served MCP tools', source: 'packages/myco-server/src/core/tool-catalogue.ts', section: '7.3', scan: () => [...SERVED_TOOLS].sort() },
  { label: 'retained tasks', source: 'packages/myco-server/src/core/task-catalogue.ts', section: '7.4', scan: () => [...RETAINED_TASKS].sort() },
  { label: 'task schedule', source: 'packages/myco-server/src/core/jobs.ts', section: '7.4', scan: () => Object.keys(TASK_SCHEDULE).sort() },
  { label: 'server jobs', source: 'packages/myco-server/src/core/jobs.ts', section: '7.5', scan: () => SERVER_JOBS.map((job) => job.name).sort() },
  { label: 'Deployment settings leaves', source: 'packages/myco-server/src/core/settings.ts', section: '7.8', scan: () => [...DEPLOYMENT_LEAVES].sort() },
  { label: 'viewer appearance', source: 'packages/myco-server/ui/src/lib/appearance-values.ts', section: '7.8',
    scan: () => Object.keys(viewerAppearance).map(leaf => `appearance.${leaf}`).sort() },
  { label: 'machine settings leaves', source: 'packages/myco-server/src/core/machine-settings.ts', section: '7.8', scan: () => [...MACHINE_LEAVES].sort() },
];

/**
 * The 1.4 registries deleted with the code that held them, each with the tokens its last scan read. Those tokens stand
 * in for the scan, so each one's §7 row stays as the record of the retired surface. A label joins this list in the
 * change that deletes its source, and only then.
 */
const RETIRED_REGISTRIES: Readonly<Record<string, readonly string[]>> = {
  'MCP tools': [
    "myco_agent",
    "myco_cortex",
    "myco_plans",
    "myco_search",
    "myco_sessions",
    "myco_skills",
    "myco_spores"
  ],
  'agent tasks': [
    "container-smoke",
    "canopy-describe",
    "canopy-map",
    "cortex-instructions",
    "cortex-prompt-builder",
    "digest-only",
    "extract-only",
    "harness-health",
    "review-session",
    "skill-evolve",
    "skill-generate",
    "skill-survey",
    "supersession-sweep",
    "title-summary",
    "vault-evolve",
    "vault-seed"
  ],
  'scheduled jobs': [
    "managed-files-reconcile",
    "agent-run-retention",
    "auto-backup",
    "canopy-background-scan",
    "capture-buffer-drain",
    "capture-only-notice-sweep",
    "content-claim-expiry",
    "database-integrity-check",
    "database-optimize",
    "embedding-reconcile",
    "log-retention",
    "notification-retention",
    "release-provenance-reconcile",
    "routed-event-dedup-prune",
    "routed-transcript-cache-gc",
    "self-reconcile",
    "service-reconcile",
    "session-maintenance",
    "staging-gc",
    "symbiont-detection",
    "upgrade-adopt",
    "upgrade-auto-check"
  ],
  'config leaves': [
    "agent.cold_project_threshold_days",
    "agent.event_tasks_enabled",
    "agent.harness",
    "agent.model",
    "agent.provider.base_url",
    "agent.provider.context_length",
    "agent.provider.effort_map.default.effort",
    "agent.provider.effort_map.default.verbosity",
    "agent.provider.effort_map.high.effort",
    "agent.provider.effort_map.high.verbosity",
    "agent.provider.effort_map.low.effort",
    "agent.provider.effort_map.low.verbosity",
    "agent.provider.local_backend",
    "agent.provider.model",
    "agent.provider.reasoning_map.default",
    "agent.provider.reasoning_map.high",
    "agent.provider.reasoning_map.low",
    "agent.provider.thinking_budget_map.default",
    "agent.provider.thinking_budget_map.high",
    "agent.provider.thinking_budget_map.low",
    "agent.provider.type",
    "agent.reasoningLevel",
    "agent.run_retention_days",
    "agent.scheduled_tasks_active_window_days",
    "agent.scheduled_tasks_enabled",
    "agent.semantic_write_check_enabled",
    "agent.summary_batch_interval",
    "agent.tasks",
    "appearance.density",
    "appearance.font",
    "appearance.mode",
    "appearance.theme",
    "backup.auto_interval_hours",
    "backup.dir",
    "backup.retention.keep_daily",
    "backup.retention.keep_weekly",
    "capture.artifact_extensions",
    "capture.buffer_max_events",
    "capture.ignore.paths",
    "capture.ignore.patterns",
    "capture.ignore_plan_dirs_in_git",
    "capture.plan_dirs",
    "capture.transcript_paths",
    "config_version",
    "cortex.canopy.enabled",
    "cortex.canopy.exclude.default_patterns",
    "cortex.canopy.exclude.patterns",
    "cortex.canopy.inject_on_pre_tool_use",
    "cortex.canopy.min_file_bytes",
    "cortex.canopy.refresh.background_enabled",
    "cortex.canopy.refresh.background_period_minutes",
    "cortex.digest.inject_on_session_start",
    "cortex.digest.tier",
    "cortex.enabled",
    "cortex.instructions.inject_on_session_start",
    "cortex.instructions.inject_on_subagent_start",
    "cortex.plans.inject_intent_nudge_on_prompt_submit",
    "cortex.spores.inject_on_prompt_submit",
    "cortex.spores.max_per_prompt",
    "daemon.log_level",
    "daemon.log_retention_days",
    "daemon.stale_session_threshold_ms",
    "embedding.base_url",
    "embedding.model",
    "embedding.prevent_deep_sleep",
    "embedding.provider",
    "maintenance.auto_integrity_check",
    "maintenance.auto_integrity_check_interval_hours",
    "maintenance.auto_optimize",
    "maintenance.auto_optimize_interval_hours",
    "notifications.default_mode",
    "notifications.domains",
    "notifications.enabled",
    "notifications.retention_days",
    "notifications.system_notifications",
    "release_provenance.enabled",
    "release_provenance.github.max_lookups_per_run",
    "release_provenance.github.repo",
    "release_provenance.github.token_env",
    "release_provenance.integration_refs",
    "release_provenance.package_map",
    "release_provenance.production_debug_include_unknown",
    "release_provenance.production_refs",
    "release_provenance.reconcile_interval_minutes",
    "skills.confidence_threshold",
    "skills.enabled",
    "skills.usage_stale_days",
    "symbionts",
    "update.channel",
    "vault_evolution.enabled",
    "version"
  ],
  'dashboard routes': [
    '*', '/', '/agent', '/agent/:id', '/cortex', '/g/:groveSlug/dashboard', '/g/:groveSlug/maintenance',
    '/g/:groveSlug/operations', '/g/:groveSlug/p/:projectSlug', '/g/:groveSlug/settings', '/g/:groveSlug/team',
    '/g/:groveSlug/team/maintenance', '/groves', '/logs', '/machine', '/machine/settings', '/mycelium', '/onboarding',
    '/operations', '/sessions', '/sessions/:id', '/settings', '/skills', '/symbionts', '/system', '/team', 'agent',
    'agent/:id', 'cortex', 'mycelium', 'operations', 'sessions', 'sessions/:id', 'settings', 'skills', 'team',
  ],
};

const present = (registry: Registry): boolean => fs.existsSync(path.join(REPO_ROOT, registry.source));
const retired = (registry: Registry): boolean => registry.label in RETIRED_REGISTRIES;

/** A registry's tokens: its scan while its source is there, the tokens it held once retired. */
const tokensOf = (registry: Registry): string[] => (present(registry) ? registry.scan() : [...(RETIRED_REGISTRIES[registry.label] ?? [])]);

/** The tokens of a section that have no row there. */
const missingRows = (section: string, tokens: readonly string[]): string[] => tokens.filter((t) => !rowIn(section, t));

/**
 * KEEP and NEW rows in a section whose answering registry does not produce them, each with why: a row a live 1.4
 * registry produces that 2.0 does not answer at, until it is re-disposed.
 */
const UNANSWERED_KEPT_ROWS: Readonly<Record<string, string>> = {};

/**
 * KEEP and NEW rows in a section a live registry owns that no registry produces, each with why. Each is a capability
 * the registries cannot see yet, and leaves this list when one can.
 */
const UNPRODUCED_ROWS: Readonly<Record<string, string>> = {};

describe('feature-preservation ledger completeness', () => {
  it('owns the guided setup command on the member surface', () => {
    expect(cliCommands()).toContain('setup');
    const row = rowIn('7.1', 'setup');
    expect(row?.disposition).toBe('NEW');
    expect(row?.surfaces).toContain('M');
  });
  it('parses a non-trivial ledger (guards against a silently empty parse)', () => {
    expect(LEDGER.length).toBeGreaterThan(100);
  });

  it('scans every registry whose source is there, and names every other one retired', () => {
    const gone = REGISTRIES.filter((registry) => !present(registry)).map((registry) => registry.label);
    expect(gone.filter((label) => !(label in RETIRED_REGISTRIES)), 'a registry\'s source is gone but it is not named in RETIRED_REGISTRIES: name it there only when its code is deliberately retired').toEqual([]);
    const stale = Object.keys(RETIRED_REGISTRIES).filter((label) => !REGISTRIES.some((registry) => registry.label === label) || REGISTRIES.some((registry) => registry.label === label && present(registry)));
    expect(stale, 'RETIRED_REGISTRIES names a registry that is unknown or whose source is still there').toEqual([]);
  });

  for (const registry of REGISTRIES) {
    const { label } = registry;
    it.skipIf(!present(registry) && !retired(registry))(`every ${label} entry carries a disposition and an owning surface`, () => {
      const tokens = tokensOf(registry);
      expect(tokens.length).toBeGreaterThan(0);

      const missing = missingRows(registry.section, tokens);
      expect(
        missing,
        `${label} with no ledger row in docs/architecture/myco-2.0.md §${registry.section} — every capability needs an explicit KEEP/REPLACE/DROP and an owning surface: ${missing.join(', ')}`,
      ).toEqual([]);

      // A token another section also names (`settings` in §7.1 and §7.2) is answered by its own section's row.
      const elsewhere = tokens.filter((t) => rowIn(registry.section, t)!.section !== registry.section);
      expect(elsewhere, `${label} answered by a row outside §${registry.section}`).toEqual([]);

      const unowned = tokens.filter((t) => {
        const row = rowIn(registry.section, t)!;
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
    const unresolved = REGISTRIES.filter((registry) => present(registry) || retired(registry)).flatMap((registry) => tokensOf(registry).filter((t) => !rowIn(registry.section, t)).map((t) => `${registry.section} ${t}`));
    expect(unresolved).toEqual([]);
  });

  it('owns every §7 section whose rows the ledger parses with a registry, live or retired', () => {
    const sections = [...new Set(LEDGER.map((row) => row.section))].sort();
    const owned = new Set(REGISTRIES.map((registry) => registry.section));
    expect(sections.filter((section) => !owned.has(section)), 'a §7 section no registry owns: its rows answer to nothing').toEqual([]);
  });

  it('reads a nested route as the full path it answers at, and finds a nested route with no row', () => {
    const tree: RouteNode[] = [{ children: [{ path: '/p/:projectId', children: [{ path: 'sessions' }, { path: 'sessions/:id' }, { path: 'unrowed' }] }] }];
    expect(routePaths!(tree)).toEqual(['/p/:projectId', '/p/:projectId/sessions', '/p/:projectId/sessions/:id', '/p/:projectId/unrowed']);
    expect(missingRows('7.2', routePaths!(tree))).toEqual(['/p/:projectId/sessions/:id', '/p/:projectId/unrowed']);
  });

  it('holds a section 2.0 answers in to what it answers: its routes sit on KEEP or NEW rows, and its KEEP or NEW rows are its routes', () => {
    for (const registry of REGISTRIES.filter((r) => r.answers === true && present(r))) {
      const answered = new Set(registry.scan());
      const replaced = [...answered].filter((t) => { const row = rowIn(registry.section, t); return row !== undefined && row.disposition !== 'KEEP' && row.disposition !== 'NEW'; });
      expect(replaced, `${registry.label} answers at a route its §${registry.section} row replaces or drops: what 2.0 serves is kept`).toEqual([]);
      const unanswered = LEDGER
        .filter((row) => row.section === registry.section && (row.disposition === 'KEEP' || row.disposition === 'NEW') && !answered.has(row.token))
        .map((row) => `${row.section} ${row.token}`);
      expect(unanswered.filter((key) => !(key in UNANSWERED_KEPT_ROWS)), `a KEEP or NEW §${registry.section} row ${registry.label} does not answer at`).toEqual([]);
      expect(Object.keys(UNANSWERED_KEPT_ROWS).filter((key) => key.startsWith(`${registry.section} `) && !unanswered.includes(key)), 'an UNANSWERED_KEPT_ROWS entry now answered: delete it').toEqual([]);
      // A replaced row that names where 2.0 serves it names a path 2.0 answers at.
      const unserved = LEDGER
        .filter((row) => row.section === registry.section && row.disposition === 'REPLACE')
        .flatMap((row) => [...row.raw.split('|').slice(2).join('|').matchAll(/`(\/[^`\s]*)`/g)]
          .map((m) => m[1]!).filter((named) => !answered.has(named)).map((named) => `${row.token} → ${named}`));
      expect(unserved, `a REPLACE §${registry.section} row names a path ${registry.label} does not answer at`).toEqual([]);
    }
  });

  it('keeps no capability whose code is gone: every KEEP or NEW row in a live registry\'s section is a token one of them produces', () => {
    const owned = new Map<string, Set<string>>();
    for (const registry of REGISTRIES) {
      if (!owned.has(registry.section)) owned.set(registry.section, new Set());
      if (present(registry)) for (const token of registry.scan()) owned.get(registry.section)!.add(token);
    }
    // A section whose every registry is retired keeps its rows as the record, with nothing left to produce them.
    const live = new Set(REGISTRIES.filter((registry) => !retired(registry)).map((registry) => registry.section));
    const unproduced = LEDGER
      .filter((row) => (row.disposition === 'KEEP' || row.disposition === 'NEW') && live.has(row.section) && !owned.get(row.section)!.has(row.token))
      .map((row) => `${row.section} ${row.token}`);
    expect(unproduced.filter((key) => !(key in UNPRODUCED_ROWS)), 'a KEEP or NEW row no registry produces: its code is gone, or it sits in the wrong section').toEqual([]);
    expect(Object.keys(UNPRODUCED_ROWS).filter((key) => !unproduced.includes(key)), 'an UNPRODUCED_ROWS entry a registry now produces: delete it').toEqual([]);
  });

  it('holds a retired registry to the tokens it had: every row in its section is a token a registry produces or held', () => {
    for (const section of new Set(REGISTRIES.filter(retired).map((registry) => registry.section))) {
      const held = new Set(REGISTRIES.filter((registry) => registry.section === section).flatMap(tokensOf));
      const unheld = LEDGER.filter((row) => row.section === section && !held.has(row.token)).map((row) => `${row.section} ${row.token}`);
      expect(unheld, 'a row no registry produces or held: a token dropped from RETIRED_REGISTRIES, or a row in the wrong section').toEqual([]);
    }
  });
});

describe('retired settings dispositions', () => {
  it('drops each retired contract while preserving its ledger row', () => {
    const ledger = fs.readFileSync('docs/architecture/myco-2.0.md', 'utf8');
    for (const leaf of [...RETIRED_LEAVES, 'skills.enabled']) {
      const row = ledger.split('\n').find((line) => line.startsWith(`| \`${leaf}\` |`));
      expect({ leaf, dropped: row?.includes(' | DROP | — | — |') }).toEqual({ leaf, dropped: true });
    }
  });
});

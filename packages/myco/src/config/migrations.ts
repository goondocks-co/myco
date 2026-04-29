/**
 * Config and vault migrations — run once per version, tracked by config_version.
 *
 * Each migration has a version number, a name, and a function that receives
 * the raw parsed YAML doc and the vault directory. Migrations run in order
 * and are skipped if config_version is already past them.
 *
 * To add a new migration:
 * 1. Add an entry to MIGRATIONS with the next version number
 * 2. Write the migrate function — it receives the mutable doc and vaultDir
 * 3. The framework handles version tracking and writing the config back
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  name: string;
  migrate: (doc: Record<string, unknown>, vaultDir: string) => void;
  /**
   * Whether this migration applies to `local.yaml` (Partial<MycoConfig>) too.
   * Defaults to `true` for renames and moves — those should run on both
   * project and local configs so user overrides keep working after a path
   * rename. Set to `false` for migrations that *seed defaults* (auto-create
   * parent keys to populate values), since local.yaml is meant to stay
   * sparse and only carry overrides — silently expanding it would force
   * the seeded values to win the merge.
   */
  appliesToLocal?: boolean;
}

/** Regex matching both quoted and unquoted YAML: type: memory, type: "memory", type: 'memory' */
const MEMORY_TYPE_PATTERN = /type:\s*["']?memory["']?/g;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'rename-memories-to-spores',
    migrate: (doc, vaultDir) => {
      // Config: rename context.layers.memories → context.layers.spores
      const context = doc.context as Record<string, unknown> | undefined;
      const layers = context?.layers as Record<string, unknown> | undefined;
      if (layers && 'memories' in layers && !('spores' in layers)) {
        layers.spores = layers.memories;
        delete layers.memories;
      }

      // Vault: rename memories/ directory → spores/
      const memoriesDir = path.join(vaultDir, 'memories');
      const sporesDir = path.join(vaultDir, 'spores');

      if (!fs.existsSync(memoriesDir)) return;

      if (fs.existsSync(sporesDir)) {
        // Both exist (interrupted migration) — merge remaining files
        const moveRemaining = (srcDir: string, destDir: string): void => {
          for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            if (entry.isDirectory()) {
              if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
              moveRemaining(srcPath, destPath);
            } else if (!fs.existsSync(destPath)) {
              fs.renameSync(srcPath, destPath);
            }
          }
        };
        moveRemaining(memoriesDir, sporesDir);
        fs.rmSync(memoriesDir, { recursive: true, force: true });
      } else {
        fs.renameSync(memoriesDir, sporesDir);
      }

      // Update frontmatter type: memory → type: spore (handles quoted and unquoted)
      const walkUpdate = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walkUpdate(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          MEMORY_TYPE_PATTERN.lastIndex = 0;
          if (MEMORY_TYPE_PATTERN.test(content)) {
            MEMORY_TYPE_PATTERN.lastIndex = 0;
            fs.writeFileSync(fullPath, content.replace(MEMORY_TYPE_PATTERN, 'type: spore'));
          }
        }
      };
      walkUpdate(sporesDir);

      // Legacy: update wikilink references in Markdown files (pre-SQLite migration): [[memories/...]] → [[spores/...]]
      const walkLinks = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walkLinks(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes('memories/')) {
            fs.writeFileSync(fullPath, content.replace(/memories\//g, 'spores/'));
          }
        }
      };
      walkLinks(vaultDir);
    },
  },
  {
    version: 2,
    name: 'consolidation-boolean-to-object',
    migrate: (doc) => {
      const digest = doc.digest as Record<string, unknown> | undefined;
      if (!digest) return;

      const consolidation = digest.consolidation;
      if (typeof consolidation === 'boolean') {
        digest.consolidation = { enabled: consolidation, max_tokens: 2048 };
      }
    },
  },
  {
    version: 3,
    name: 'schedule-to-task-level',
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      const agent = (doc.agent ?? {}) as Record<string, unknown>;
      const skills = (doc.skills ?? {}) as Record<string, unknown>;
      const tasks = ((agent.tasks ?? {}) as Record<string, Record<string, unknown>>);

      /** Default interval for full-intelligence task (5 minutes). */
      const DEFAULT_INTELLIGENCE_INTERVAL_SECONDS = 300;

      const VALID_SCHEDULE_STATES = ['active', 'idle', 'sleep'] as const;

      // Migrate agent.auto_run + interval_seconds → full-intelligence schedule
      if ('auto_run' in agent || 'interval_seconds' in agent) {
        const fiTask = tasks['full-intelligence'] ?? {};
        fiTask.schedule = {
          enabled: agent.auto_run ?? true,
          intervalSeconds: agent.interval_seconds ?? DEFAULT_INTELLIGENCE_INTERVAL_SECONDS,
        };
        tasks['full-intelligence'] = fiTask;
        delete agent.auto_run;
        delete agent.interval_seconds;
      }

      // Migrate skills.auto_survey → skill-survey schedule
      if ('auto_survey' in skills) {
        const ssTask = tasks['skill-survey'] ?? {};
        ssTask.schedule = {
          enabled: skills.auto_survey ?? false,
        };
        tasks['skill-survey'] = ssTask;
        delete skills.auto_survey;
      }

      // Migrate skills.auto_evolve + evolve_cadence → skill-evolve schedule
      if ('auto_evolve' in skills || 'evolve_cadence' in skills) {
        const seTask = tasks['skill-evolve'] ?? {};
        const schedule: Record<string, unknown> = {
          enabled: skills.auto_evolve ?? false,
        };
        if ('evolve_cadence' in skills) {
          const cadence = String(skills.evolve_cadence);
          schedule.runIn = VALID_SCHEDULE_STATES.includes(cadence as typeof VALID_SCHEDULE_STATES[number])
            ? [cadence]
            : ['idle']; // fallback to safe default
        }
        seTask.schedule = schedule;
        tasks['skill-evolve'] = seTask;
        delete skills.auto_evolve;
        delete skills.evolve_cadence;
      }

      // Write back tasks if any were created
      if (Object.keys(tasks).length > 0) {
        agent.tasks = tasks;
      }
      // Only re-attach `agent`/`skills` when they have content. Sparse
      // local.yaml docs would otherwise gain empty `agent: {}` / `skills: {}`
      // blocks just from running this migration with nothing to do.
      if (Object.keys(agent).length > 0) doc.agent = agent;
      if (Object.keys(skills).length > 0) doc.skills = skills;
    },
  },
  {
    version: 4,
    name: 'rename-cloud-provider-to-anthropic',
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      // Rename `provider.type: cloud` -> `provider.type: anthropic` everywhere
      // it appears in the agent config: global default, per-task, per-phase.
      const renameProvider = (provider: unknown): void => {
        if (
          provider &&
          typeof provider === 'object' &&
          (provider as Record<string, unknown>).type === 'cloud'
        ) {
          (provider as Record<string, unknown>).type = 'anthropic';
        }
      };

      const agent = doc.agent as Record<string, unknown> | undefined;
      if (!agent) return;

      // Global default provider
      renameProvider(agent.provider);

      // Per-task overrides
      const tasks = agent.tasks as Record<string, Record<string, unknown>> | undefined;
      if (tasks) {
        for (const taskConfig of Object.values(tasks)) {
          renameProvider(taskConfig.provider);

          // Per-phase overrides within a task
          const phases = taskConfig.phases as Record<string, Record<string, unknown>> | undefined;
          if (phases) {
            for (const phaseConfig of Object.values(phases)) {
              renameProvider(phaseConfig.provider);
            }
          }
        }
      }
    },
  },
  {
    version: 5,
    name: 'seed-settings-notification-domain-default',
    // Seeder: auto-creates notifications.domains.settings on bare configs.
    // Skipped for local.yaml — that file is meant to stay sparse, and
    // injecting a seeded settings block here would override the project
    // config's value via the merge layer.
    appliesToLocal: false,
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      const notifications = (doc.notifications ??= {}) as Record<string, unknown>;
      const domains = (notifications.domains ??= {}) as Record<string, unknown>;
      const settings = (domains.settings ??= {}) as Record<string, unknown>;

      if (!('enabled' in settings)) settings.enabled = true;
      if (!('mode' in settings)) settings.mode = 'banner';
    },
  },
  {
    version: 6,
    name: 'rename-full-intelligence-to-vault-evolve',
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      // The built-in task `full-intelligence` was renamed to `vault-evolve`.
      // Move any user overrides stored under the old task key so their
      // schedule, model, and phase settings keep applying.
      const agent = doc.agent as Record<string, unknown> | undefined;
      if (!agent) return;
      const tasks = agent.tasks as Record<string, unknown> | undefined;
      if (!tasks || !('full-intelligence' in tasks)) return;

      const legacy = tasks['full-intelligence'];
      const existing = tasks['vault-evolve'];

      // If a user somehow has both (e.g., hand-edited config), keep the
      // newer key and drop the legacy one rather than clobbering.
      if (!existing) {
        tasks['vault-evolve'] = legacy;
      }
      delete tasks['full-intelligence'];
    },
  },
  {
    version: 7,
    name: 'dedupe-canopy-exclude-patterns-against-baseline',
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      // Pre-v7, projects had to hand-list `.git`, `node_modules`, etc. in
      // `canopy.exclude.patterns` because the scanner had no baseline.
      // The Myco-maintained baseline (`canopy.exclude.default_patterns`)
      // now covers those by default — entries duplicated in user
      // patterns are pure noise. Strip exact-match duplicates so the
      // "Your patterns" UI list shows only what the user genuinely
      // added on top of the baseline.
      const canopy = doc.canopy as Record<string, unknown> | undefined;
      if (!canopy) return;
      const exclude = canopy.exclude as Record<string, unknown> | undefined;
      if (!exclude) return;
      const patterns = exclude.patterns;
      if (!Array.isArray(patterns)) return;

      // Keep this list in sync with CANOPY_DEFAULT_EXCLUDE_PATTERNS in
      // packages/myco/src/config/schema.ts. Inlined here so the migration
      // is frozen at the v7 contract — future baseline additions don't
      // retroactively rewrite older user configs.
      const V7_BASELINE = new Set([
        '.git', '.DS_Store',
        'node_modules',
        '__pycache__',
        '.venv', 'venv', 'env', 'ENV',
        '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox',
        'dist', 'build', 'target', '.gradle', '.cache',
        '.next', '.nuxt', '.turbo', '.svelte-kit',
        '**/*.lock',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
      ]);
      const filtered = (patterns as unknown[]).filter(
        (p) => typeof p !== 'string' || !V7_BASELINE.has(p),
      );
      if (filtered.length !== patterns.length) {
        exclude.patterns = filtered;
      }
    },
  },
  {
    version: 8,
    name: 'unify-cortex-config-shape',
    /**
     * Pre-v8, Cortex's settings were scattered across:
     *   - `context.cortex_enabled` / `context.session_start_digest_enabled`
     *     / `context.digest_tier` / `context.prompt_search` / `context.prompt_max_spores`
     *     (root `context:` block, mixed-purpose: injection toggles + retrieval defaults)
     *   - `canopy.refresh` / `canopy.exclude` (root `canopy:` data plane)
     *   - `cortex.canopy.injection.enabled` / `cortex.canopy.injection.size_threshold`
     *
     * v8 unifies everything under `cortex.*` organized by feature
     * (instructions/digest/spores/canopy) with `inject_on_<event>`
     * toggles standardized on lifecycle events (session_start,
     * prompt_submit, pre_tool_use). The root `context:` and root
     * `canopy:` blocks are dropped.
     *
     * Tolerant of sparse docs (runs on local.yaml too) — every read
     * checks for the parent before assuming it exists, and we never
     * auto-seed empty parents.
     */
    migrate(doc: Record<string, unknown>, _vaultDir: string): void {
      const ctx = doc.context as Record<string, unknown> | undefined;
      const rootCanopy = doc.canopy as Record<string, unknown> | undefined;
      const cortex = (doc.cortex ??= {}) as Record<string, unknown>;

      // --- context.* → cortex.*  ---
      if (ctx) {
        if ('cortex_enabled' in ctx) {
          // Today this single flag gates session-start instruction
          // injection. v8 splits master enable from the per-event
          // toggle; since there's no UX to disable Cortex entirely
          // (and never has been), map the legacy flag exclusively to
          // instructions.inject_on_session_start. cortex.enabled
          // stays at its Zod default of true.
          const instructions = (cortex.instructions ??= {}) as Record<string, unknown>;
          instructions.inject_on_session_start = ctx.cortex_enabled;
          delete ctx.cortex_enabled;
        }
        if ('digest_tier' in ctx || 'session_start_digest_enabled' in ctx) {
          const digest = (cortex.digest ??= {}) as Record<string, unknown>;
          if ('digest_tier' in ctx) {
            digest.tier = ctx.digest_tier;
            delete ctx.digest_tier;
          }
          if ('session_start_digest_enabled' in ctx) {
            digest.inject_on_session_start = ctx.session_start_digest_enabled;
            delete ctx.session_start_digest_enabled;
          }
        }
        if ('prompt_search' in ctx || 'prompt_max_spores' in ctx) {
          const spores = (cortex.spores ??= {}) as Record<string, unknown>;
          if ('prompt_search' in ctx) {
            spores.inject_on_prompt_submit = ctx.prompt_search;
            delete ctx.prompt_search;
          }
          if ('prompt_max_spores' in ctx) {
            spores.max_per_prompt = ctx.prompt_max_spores;
            delete ctx.prompt_max_spores;
          }
        }
        // operating_brief_enabled was the legacy alias the old
        // ContextSchema preprocessor handled. Apply the same rename
        // here so any forgotten config still migrates.
        if ('operating_brief_enabled' in ctx) {
          const instructions = (cortex.instructions ??= {}) as Record<string, unknown>;
          if (!('inject_on_session_start' in instructions)) {
            instructions.inject_on_session_start = ctx.operating_brief_enabled;
          }
          delete ctx.operating_brief_enabled;
        }
        if (Object.keys(ctx).length === 0) {
          delete doc.context;
        }
      }

      // --- root canopy.* → cortex.canopy.* (data plane) ---
      if (rootCanopy) {
        const cortexCanopy = (cortex.canopy ??= {}) as Record<string, unknown>;
        if ('refresh' in rootCanopy && !('refresh' in cortexCanopy)) {
          cortexCanopy.refresh = rootCanopy.refresh;
        }
        if ('exclude' in rootCanopy && !('exclude' in cortexCanopy)) {
          cortexCanopy.exclude = rootCanopy.exclude;
        }
        delete doc.canopy;
      }

      // --- cortex.canopy.injection.* → flat fields on cortex.canopy ---
      const cortexCanopy = cortex.canopy as Record<string, unknown> | undefined;
      const injection = cortexCanopy?.injection as Record<string, unknown> | undefined;
      if (cortexCanopy && injection) {
        if ('enabled' in injection && !('inject_on_pre_tool_use' in cortexCanopy)) {
          cortexCanopy.inject_on_pre_tool_use = injection.enabled;
        }
        if ('size_threshold' in injection && !('min_file_bytes' in cortexCanopy)) {
          cortexCanopy.min_file_bytes = injection.size_threshold;
        }
        delete cortexCanopy.injection;
      }

      // Tidy up: don't leave an empty `cortex: {}` if nothing migrated.
      if (Object.keys(cortex).length === 0) {
        delete doc.cortex;
      }
    },
  },
];

/** Current migration version — the highest version in MIGRATIONS. */
export const CURRENT_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Identifies which config doc is being migrated. `project` is the canonical
 * `myco.yaml`; `local` is the sparse override file `local.yaml`. Used to
 * skip `appliesToLocal: false` migrations (typically default-seeders) when
 * walking a `local.yaml` doc.
 */
export type MigrationTarget = 'project' | 'local';

/**
 * Cheap structural fingerprint used to detect whether a migration body
 * actually changed the doc. We compare JSON.stringify output (key order
 * is stable for object-literal mutation patterns the migrations use), so
 * a no-op migration on a sparse local.yaml doesn't tick the version
 * counter and force a write-back of an otherwise-identical file.
 */
function fingerprint(doc: Record<string, unknown>): string {
  return JSON.stringify(doc);
}

/**
 * Run all pending migrations on the raw config doc.
 * Returns true if any migrations actually mutated the doc.
 *
 * `target` defaults to `'project'` to preserve the legacy single-file
 * call signature. Pass `'local'` from `loadLocalConfig` so seed-style
 * migrations are skipped — local.yaml is meant to stay sparse, and
 * silently injecting seeded values would override the project config
 * through the merge layer.
 *
 * For project myco.yaml: every pending migration is run; version
 * counter advances even on no-ops because the canonical config is
 * always brought up to the current shape.
 *
 * For local.yaml: a migration that runs but doesn't mutate the doc
 * does NOT advance the version counter. This keeps legacy sparse
 * local.yaml files (predating the migration system) from gaining a
 * `config_version` stamp on the first load that triggers a no-op
 * write-back.
 */
export function runMigrations(
  doc: Record<string, unknown>,
  vaultDir: string,
  log?: (message: string) => void,
  target: MigrationTarget = 'project',
): boolean {
  const currentVersion = (doc.config_version as number) ?? 0;
  let ran = false;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (target === 'local' && migration.appliesToLocal === false) {
      // Skip seed-style migrations on local.yaml. Don't stamp
      // config_version either — that would force a no-op write-back of
      // a pre-existing sparse local.yaml that the user never asked us
      // to mutate.
      continue;
    }

    if (target === 'local') {
      // No-op detection: only stamp + flip `ran` when the migration
      // body actually mutated the doc.
      const before = fingerprint(doc);
      migration.migrate(doc, vaultDir);
      if (fingerprint(doc) !== before) {
        doc.config_version = migration.version;
        ran = true;
      }
    } else {
      migration.migrate(doc, vaultDir);
      doc.config_version = migration.version;
      ran = true;
    }
  }

  if (ran) {
    const from = currentVersion;
    const to = (doc.config_version as number) ?? currentVersion;
    const label = target === 'local' ? 'local config' : 'config';
    log?.(`Migrated ${label} from v${from} to v${to}`);
  }

  return ran;
}

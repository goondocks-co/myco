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
      doc.agent = agent;
      doc.skills = skills;
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
];

/** Current migration version — the highest version in MIGRATIONS. */
export const CURRENT_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Run all pending migrations on the raw config doc.
 * Returns true if any migrations ran (caller should reindex).
 */
export function runMigrations(
  doc: Record<string, unknown>,
  vaultDir: string,
  log?: (message: string) => void,
): boolean {
  const currentVersion = (doc.config_version as number) ?? 0;
  let ran = false;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    migration.migrate(doc, vaultDir);
    doc.config_version = migration.version;
    ran = true;
  }

  if (ran) {
    const from = currentVersion;
    const to = (doc.config_version as number) ?? 0;
    log?.(`Migrated config from v${from} to v${to}`);
  }

  return ran;
}

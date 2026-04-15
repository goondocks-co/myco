import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { MycoConfigSchema, type MycoConfig, type BackupConfig, type TeamConfig } from './schema.js';
import { runMigrations, CURRENT_MIGRATION_VERSION } from './migrations.js';
import { deepMerge } from '../utils/deep-merge.js';

export const CONFIG_FILENAME = 'myco.yaml';
export const LOCAL_CONFIG_FILENAME = 'local.yaml';

function localConfigPath(vaultDir: string): string {
  // vaultDir already points at `.myco/` (see resolveVaultDir), so local.yaml
  // sits alongside myco.yaml in the vault — no extra `.myco/` prefix.
  return path.join(vaultDir, LOCAL_CONFIG_FILENAME);
}

/** Config overlay uses replace semantics: arrays in source overwrite arrays in target. */
export function deepMergeConfig<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  return deepMerge(target, source, { arrayStrategy: 'replace' });
}

export function loadConfig(vaultDir: string): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    throw new Error(`myco.yaml not found in ${vaultDir}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as Record<string, unknown>;

  // Detect v1 config and guide migration
  if (parsed.version === 1 || (parsed.intelligence as Record<string, unknown>)?.backend) {
    throw new Error(
      'Myco config uses v1 format. Run /myco:setup-llm to reconfigure for v2.',
    );
  }

  // --- v2 → v3 migration ---
  let v2Migrated = false;
  if (parsed.version === 2) {
    // Extract intelligence.embedding to top-level embedding
    const intel = parsed.intelligence as Record<string, unknown> | undefined;
    const embeddingConfig = intel?.embedding as Record<string, unknown> | undefined;
    if (embeddingConfig && !parsed.embedding) {
      // Map v2 'lm-studio' to v3 'openai-compatible' for embedding provider
      if (embeddingConfig.provider === 'lm-studio') {
        embeddingConfig.provider = 'openai-compatible';
      }
      parsed.embedding = embeddingConfig;
    }

    // Keep daemon.port and daemon.log_level, drop grace_period and max_log_size
    const daemon = parsed.daemon as Record<string, unknown> | undefined;
    if (daemon) {
      const { port, log_level } = daemon;
      parsed.daemon = { port: port ?? null, log_level: log_level ?? 'info' };
    }

    // Keep capture basics, drop token-related fields; migrate artifact_watch → plan_dirs
    const capture = parsed.capture as Record<string, unknown> | undefined;
    if (capture) {
      const { transcript_paths, artifact_watch, plan_dirs, artifact_extensions, buffer_max_events } = capture;
      parsed.capture = {
        transcript_paths,
        plan_dirs: plan_dirs ?? artifact_watch,
        artifact_extensions,
        buffer_max_events,
      };
    }

    // Drop removed top-level sections
    delete parsed.intelligence;
    delete parsed.context;
    delete parsed.team;
    delete parsed.digest;
    delete parsed.pipeline;

    // Set version to 3
    parsed.version = 3;
    v2Migrated = true;

    process.stderr.write('[myco migration] Migrated config from v2 to v3\n');
  }

  // Run numbered migrations (for v3+ forward migrations)
  const migrationsRan = runMigrations(parsed, vaultDir, (msg) => {
    process.stderr.write(`[myco migration] ${msg}\n`);
  });

  // Parse with Zod to fill in defaults for new config sections
  const config = MycoConfigSchema.parse(parsed);

  // Write back if v2→v3 migration ran, numbered migrations ran, or new defaults were added
  const needsWrite = v2Migrated
    || migrationsRan
    || (parsed.config_version as number ?? 0) < CURRENT_MIGRATION_VERSION
    || parsed.version !== config.version;

  if (needsWrite) {
    const fullConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    fs.writeFileSync(configPath, YAML.stringify(fullConfig), 'utf-8');
  }

  return config;
}

export function saveConfig(vaultDir: string, config: MycoConfig): void {
  // Validate before writing — OAK lesson: validate on write, not just read
  const validated = MycoConfigSchema.parse(config);

  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(validated), 'utf-8');
}

export function updateConfig(
  vaultDir: string,
  fn: (config: MycoConfig) => MycoConfig,
): MycoConfig {
  const current = loadConfig(vaultDir);
  const updated = fn(current);
  saveConfig(vaultDir, updated);
  return updated;
}

export function updateBackupConfig(
  vaultDir: string,
  backup: Partial<BackupConfig>,
): MycoConfig {
  return updateConfig(vaultDir, (config) => ({
    ...config,
    backup: { ...config.backup, ...backup },
  }));
}

/**
 * Extract the set of enabled symbiont names from config.
 * Returns null when the `symbionts` section is absent (pre-existing installs),
 * signalling callers to fall back to their own heuristic.
 */
export function getEnabledSymbiontNames(config: MycoConfig): Set<string> | null {
  if (!config.symbionts) return null;
  return new Set(
    Object.entries(config.symbionts)
      .filter(([, entry]) => entry.enabled)
      .map(([name]) => name),
  );
}

export function updateTeamConfig(
  vaultDir: string,
  team: Partial<TeamConfig>,
): MycoConfig {
  return updateConfig(vaultDir, (config) => ({
    ...config,
    team: { ...config.team, ...team },
  }));
}

/** Return raw local overrides, or `{}` if the file is missing, empty, malformed, or not a mapping. */
export function loadLocalConfig(vaultDir: string): Partial<MycoConfig> {
  const filePath = localConfigPath(vaultDir);
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    process.stderr.write(`[myco config] Failed to parse ${filePath}; ignoring local overrides. ${(err as Error).message}\n`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`[myco config] ${filePath} must contain a YAML mapping; ignoring local overrides.\n`);
    return {};
  }

  return parsed as Partial<MycoConfig>;
}

/** Load project config and overlay local overrides on top (leaf-level deep merge). */
export function loadMergedConfig(vaultDir: string): MycoConfig {
  const project = loadConfig(vaultDir);
  const local = loadLocalConfig(vaultDir);
  const merged = deepMergeConfig(project as Record<string, unknown>, local as Record<string, unknown>);
  return MycoConfigSchema.parse(merged);
}

/**
 * Write local.yaml only when the serialized contents differ from `current`.
 * Skips the write (and mkdirSync) on a no-op to avoid noisy file mtimes.
 */
function writeLocalYamlIfChanged<T>(vaultDir: string, current: T, next: T): T {
  const existingYaml = YAML.stringify(current);
  const nextYaml = YAML.stringify(next);
  if (existingYaml === nextYaml) return next;

  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(localConfigPath(vaultDir), nextYaml, 'utf-8');
  return next;
}

/** Write a partial to <vaultDir>/local.yaml, deep-merging with existing local content. */
export function saveLocalConfig(vaultDir: string, patch: Partial<MycoConfig>): Partial<MycoConfig> {
  const existing = loadLocalConfig(vaultDir);
  const next = deepMergeConfig(existing as Record<string, unknown>, patch as Record<string, unknown>) as Partial<MycoConfig>;
  return writeLocalYamlIfChanged(vaultDir, existing, next);
}

/**
 * Callback-style update for local config. Replace-semantics: the value
 * returned by `fn` is written verbatim (so callers can remove keys by
 * omitting them). Callers that want merge-semantics should spread
 * `...local` inside their callback, or use `saveLocalConfig` directly.
 */
export function updateLocalConfig(
  vaultDir: string,
  fn: (local: Partial<MycoConfig>) => Partial<MycoConfig>,
): Partial<MycoConfig> {
  const current = loadLocalConfig(vaultDir);
  return writeLocalYamlIfChanged(vaultDir, current, fn(current));
}

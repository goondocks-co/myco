import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  MycoConfigSchema,
  MachineConfigSchema,
  GroveConfigSchema,
  ProjectConfigSchema,
  PROJECT_TIER_LEGACY_FIELDS,
  type MycoConfig,
  type MachineConfig,
  type GroveConfig,
  type BackupConfig,
  type TeamConfig,
} from './schema.js';
import { runMigrations, CURRENT_MIGRATION_VERSION } from './migrations.js';
import { deepMerge } from '../utils/deep-merge.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  resolveGlobalConfigPath,
  resolveGroveConfigPath,
  resolveGroveDir,
  resolveMycoHome,
} from '../grove/paths.js';

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

// ---------------------------------------------------------------------------
// Tier helpers — strip mistier'd fields
// ---------------------------------------------------------------------------

/**
 * Silently remove project-tier fields that have been successfully moved
 * to their new home. Skips fields whose target tier wasn't writable
 * (e.g. Grove-tier `team` when no Grove is bound) so values aren't lost.
 * Returns true when anything was stripped.
 */
function stripLegacyProjectFields(
  doc: Record<string, unknown>,
  options: { hasGrove: boolean },
): boolean {
  // Grove-tier fields can only be safely stripped when there's a Grove
  // to migrate them into. Otherwise they stay until the project gets
  // bound to a Grove.
  const GROVE_TIER_FIELDS: ReadonlyArray<readonly string[]> = [
    ['daemon', 'stale_session_threshold_ms'],
    ['backup'],
    ['maintenance'],
    ['embedding', 'run_in_deep_sleep'],
    ['agent', 'scheduled_tasks_active_window_days'],
    ['team'],
  ];
  const groveTierKeys = new Set(GROVE_TIER_FIELDS.map((seg) => seg.join('.')));

  let stripped = false;
  for (const segments of PROJECT_TIER_LEGACY_FIELDS) {
    if (!options.hasGrove && groveTierKeys.has(segments.join('.'))) continue;
    if (unsetAtPath(doc, segments, { pruneEmptyParents: true })) stripped = true;
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Machine tier — ~/.myco/config.yaml
// ---------------------------------------------------------------------------

interface CachedTierConfig<T> {
  mtimeMs: number | null;
  size: number | null;
  config: T;
}

const machineConfigCache = new Map<string, CachedTierConfig<MachineConfig>>();
const groveConfigCache = new Map<string, CachedTierConfig<GroveConfig>>();

function readTierConfig<T>(
  filePath: string,
  cache: Map<string, CachedTierConfig<T>>,
  parseEmpty: () => T,
  parseDoc: (doc: unknown) => T,
): T {
  const stat = statOrNull(filePath);
  const cached = cache.get(filePath);
  if (cached
    && cached.mtimeMs === (stat?.mtimeMs ?? null)
    && cached.size === (stat?.size ?? null)) {
    return cached.config;
  }
  let result: T;
  if (!stat) {
    result = parseEmpty();
  } else {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      result = parseEmpty();
    } else {
      let parsed: unknown;
      try {
        parsed = YAML.parse(raw);
      } catch (err) {
        process.stderr.write(`[myco config] Failed to parse ${filePath}: ${(err as Error).message}\n`);
        result = parseEmpty();
        cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, config: result });
        return result;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result = parseEmpty();
      } else {
        try {
          result = parseDoc(parsed);
        } catch {
          result = parseEmpty();
        }
      }
    }
  }
  cache.set(filePath, { mtimeMs: stat?.mtimeMs ?? null, size: stat?.size ?? null, config: result });
  return result;
}

export function loadMachineConfig(mycoHome = resolveMycoHome()): MachineConfig {
  const filePath = resolveGlobalConfigPath(mycoHome);
  return readTierConfig(
    filePath,
    machineConfigCache,
    () => MachineConfigSchema.parse({}),
    (doc) => MachineConfigSchema.parse(doc),
  );
}

export function saveMachineConfig(config: MachineConfig, mycoHome = resolveMycoHome()): void {
  const validated = MachineConfigSchema.parse(config);
  const filePath = resolveGlobalConfigPath(mycoHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, YAML.stringify(validated), 'utf-8');
  machineConfigCache.delete(filePath);
  invalidateMergedConfigCache();
}

// ---------------------------------------------------------------------------
// Grove tier — ~/.myco/groves/<id>/config.yaml
// ---------------------------------------------------------------------------

export function loadGroveConfig(groveId: string, mycoHome = resolveMycoHome()): GroveConfig {
  const filePath = resolveGroveConfigPath(groveId, mycoHome);
  return readTierConfig(
    filePath,
    groveConfigCache,
    () => GroveConfigSchema.parse({}),
    (doc) => GroveConfigSchema.parse(doc),
  );
}

export function saveGroveConfig(
  groveId: string,
  config: GroveConfig,
  mycoHome = resolveMycoHome(),
): void {
  const validated = GroveConfigSchema.parse(config);
  const filePath = resolveGroveConfigPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, YAML.stringify(validated), 'utf-8');
  groveConfigCache.delete(filePath);
  invalidateMergedConfigCache();
}

/**
 * Load → transform → save in one call, matching the `updateConfig` pattern
 * for the project tier. Returns the saved (Zod-validated) GroveConfig.
 */
export function updateGroveConfig(
  groveId: string,
  transform: (current: GroveConfig) => GroveConfig,
  opts?: { mycoHome?: string },
): GroveConfig {
  const current = loadGroveConfig(groveId, opts?.mycoHome);
  const next = transform(current);
  saveGroveConfig(groveId, next, opts?.mycoHome);
  return next;
}

function readRawYamlDoc(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through; corrupt YAML is treated as empty.
  }
  return {};
}

/**
 * One-shot migration: copy mistier'd fields out of a project's myco.yaml
 * into the right Grove/Machine config files. Idempotent — running on an
 * already-migrated vault is a no-op.
 *
 * Existence checks read the RAW target YAML (no Zod defaults) so default
 * values in machine/grove configs don't block the migration. We only
 * skip when the user has already written an explicit value to the
 * target tier file.
 */
function migrateLegacyProjectFields(
  parsed: Record<string, unknown>,
  groveId: string | null,
  mycoHome: string,
): boolean {
  let moved = false;

  // Grove tier targets.
  if (groveId) {
    const grovePath = resolveGroveConfigPath(groveId, mycoHome);
    const groveRaw = readRawYamlDoc(grovePath);
    let groveDirty = false;

    const tryMove = (sourcePath: readonly string[], targetPath: readonly string[]): void => {
      const value = getAtPath(parsed, sourcePath);
      if (value === undefined) return;
      if (getAtPath(groveRaw, targetPath) !== undefined) return; // explicit value already
      setAtPath(groveRaw, targetPath, value);
      groveDirty = true;
    };

    tryMove(['daemon', 'stale_session_threshold_ms'], ['daemon', 'stale_session_threshold_ms']);
    tryMove(['backup'], ['backup']);
    tryMove(['maintenance'], ['maintenance']);
    tryMove(['embedding', 'run_in_deep_sleep'], ['embedding', 'run_in_deep_sleep']);
    tryMove(['agent', 'scheduled_tasks_active_window_days'], ['agent', 'scheduled_tasks_active_window_days']);
    tryMove(['team'], ['team']);

    if (groveDirty) {
      try {
        const validated = GroveConfigSchema.parse(groveRaw);
        saveGroveConfig(groveId, validated, mycoHome);
        moved = true;
      } catch {
        // Validation failed — drop the move attempt rather than
        // corrupting Grove storage. Field stays in project file.
      }
    }
  }

  // Machine tier targets.
  const machinePath = resolveGlobalConfigPath(mycoHome);
  const machineRaw = readRawYamlDoc(machinePath);
  let machineDirty = false;

  const moveMachine = (sourcePath: readonly string[], targetPath: readonly string[]): void => {
    const value = getAtPath(parsed, sourcePath);
    if (value === undefined) return;
    if (getAtPath(machineRaw, targetPath) !== undefined) return;
    setAtPath(machineRaw, targetPath, value);
    machineDirty = true;
  };

  // Note: do NOT promote `daemon.port`. The canonical port is derived
  // from the service path (`daemon/port.ts`) — promoting a stale legacy
  // value into machine config would re-poison `~/.myco/config.yaml` and
  // silently hijack port resolution. The MachineConfigSchema preprocess
  // strips it on read; this drop ensures it never gets re-written.
  moveMachine(['daemon', 'log_level'], ['daemon', 'log_level']);
  moveMachine(['daemon', 'log_retention_days'], ['daemon', 'log_retention_days']);
  // `update.channel` from legacy schema → daemon.update_channel.
  const updateChannel = getAtPath(parsed, ['update', 'channel']);
  if (updateChannel !== undefined && getAtPath(machineRaw, ['daemon', 'update_channel']) === undefined) {
    setAtPath(machineRaw, ['daemon', 'update_channel'], updateChannel);
    machineDirty = true;
  }

  if (machineDirty) {
    try {
      const validated = MachineConfigSchema.parse(machineRaw);
      saveMachineConfig(validated, mycoHome);
      moved = true;
    } catch {
      // Same defensive stance — leave the field in project file.
    }
  }

  return moved;
}

export interface LoadConfigOptions {
  /**
   * The Grove this project belongs to, when known. Used to route
   * legacy Grove-tier fields out of `myco.yaml` and into the right
   * Grove config file during the one-shot migration. When null, the
   * Grove-tier fields stay in place (they'll get migrated next time
   * the project is loaded under a Grove-bound request context).
   */
  groveId?: string | null;
  /** Override Myco home for tests. */
  mycoHome?: string;
  /**
   * When true, run the tier-strip migration that moves Machine + Grove
   * fields out of `myco.yaml` into their canonical config files. Off by
   * default so unit tests that exercise loadConfig without setting
   * MYCO_HOME don't contaminate the user's real `~/.myco/`. The daemon
   * boot path opts in explicitly.
   */
  migrateTiers?: boolean;
}

interface LoadConfigInternalResult {
  config: MycoConfig;
  /**
   * Post-migration sparse doc. Identical to what's persisted on disk
   * after the (optional) write-back. Returned so loadMergedConfig can
   * skip a second read+parse of the same file.
   */
  parsed: Record<string, unknown>;
}

function loadConfigInternal(vaultDir: string, options: LoadConfigOptions = {}): LoadConfigInternalResult {
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

    // Keep daemon.log_level; drop port (machine-derived now), grace_period, max_log_size
    const daemon = parsed.daemon as Record<string, unknown> | undefined;
    if (daemon) {
      const { log_level } = daemon;
      parsed.daemon = { log_level: log_level ?? 'info' };
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

  // Three-tier split: when explicitly requested, copy any Grove/Machine
  // fields from this legacy project file into their right tier files,
  // then strip them from `parsed` so the project-level YAML stays clean.
  // Off by default — call sites that own the migration (daemon boot,
  // Settings UI write paths) opt in via `migrateTiers: true`.
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const groveId = options.groveId ?? null;
  const shouldMigrate = options.migrateTiers === true;
  const tierMoved = shouldMigrate
    ? migrateLegacyProjectFields(parsed, groveId, mycoHome)
    : false;
  const tierStripped = shouldMigrate
    ? stripLegacyProjectFields(parsed, { hasGrove: groveId !== null })
    : false;

  // Parse with Zod to fill in defaults for new config sections
  const config = MycoConfigSchema.parse(parsed);

  // Write back if v2→v3 migration ran, numbered migrations ran, tier
  // migration moved fields, or new defaults were added.
  const needsWrite = v2Migrated
    || migrationsRan
    || tierMoved
    || tierStripped
    || (parsed.config_version as number ?? 0) < CURRENT_MIGRATION_VERSION
    || parsed.version !== config.version;

  if (needsWrite) {
    // Write back the post-migration sparse `parsed` doc — NOT the
    // Zod-parsed full `config` — so the project file stays free of
    // Grove/Machine-tier fields and unrelated defaults. The returned
    // `config` still has every field defaulted for runtime consumers.
    atomicWriteFileSync(configPath, YAML.stringify(parsed), 'utf-8');
  }

  return { config, parsed };
}

export function loadConfig(vaultDir: string, options: LoadConfigOptions = {}): MycoConfig {
  return loadConfigInternal(vaultDir, options).config;
}

export function saveConfig(vaultDir: string, config: MycoConfig): void {
  // Validate full shape first (OAK lesson: validate on write, not just
  // read), then filter through ProjectConfigSchema so Grove/Machine-tier
  // fields can't sneak back into the project file. Zod's default strip
  // semantics drop any unknown keys — daemon/backup/team/update etc. all
  // belong in their own tier files. The returned MycoConfig still has
  // those tiers; we just don't persist them here.
  const validated = MycoConfigSchema.parse(config);
  const projectOnly = ProjectConfigSchema.parse(validated);

  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  fs.mkdirSync(vaultDir, { recursive: true });
  atomicWriteFileSync(configPath, YAML.stringify(projectOnly), 'utf-8');
  invalidateMergedConfigCache(vaultDir);
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

/**
 * Return raw local overrides, or `{}` if the file is missing, empty,
 * malformed, or not a mapping. Runs the same migration chain as
 * `loadConfig` against the partial doc — local.yaml is a valid Myco
 * config file (just sparse), so when paths get renamed in the schema,
 * user overrides need to follow. Seed-style migrations are skipped via
 * each migration's `appliesToLocal` flag so a sparse local.yaml stays
 * sparse. The file is written back when migrations modified it.
 */
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

  const doc = parsed as Record<string, unknown>;
  const before = YAML.stringify(doc);
  runMigrations(
    doc,
    vaultDir,
    (msg) => process.stderr.write(`[myco migration] ${msg}\n`),
    'local',
  );
  const after = YAML.stringify(doc);

  // Only write back when the migration actually mutated content. The
  // chain reports `ran=true` for any version > current (even when the
  // migration body was a structural no-op against a sparse local.yaml),
  // which would otherwise stamp legacy files with `config_version` for
  // no semantic reason.
  if (before !== after) {
    atomicWriteFileSync(filePath, after, 'utf-8');
  }

  return doc as Partial<MycoConfig>;
}

/**
 * Cache for `loadMergedConfig` keyed by (vaultDir, mtime+size of myco.yaml,
 * mtime+size of local.yaml). The merge involves two YAML parses, two
 * migration walks, a deep-merge, and a Zod re-parse — `resolveRunConfig`
 * calls it on every `runAgent` invocation, so under busy task scheduling
 * the cost compounds. Mtime+size invalidation handles both internal writes
 * (loaders write back after migrating, save*Config helpers mutate) and
 * external edits (operator hand-edits myco.yaml).
 */
interface CachedMergedConfig {
  configMtimeMs: number | null;
  configSize: number | null;
  localMtimeMs: number | null;
  localSize: number | null;
  machineMtimeMs: number | null;
  machineSize: number | null;
  groveMtimeMs: number | null;
  groveSize: number | null;
  config: MycoConfig;
}

const mergedConfigCache = new Map<string, CachedMergedConfig>();

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fingerprintMatches(
  cached: CachedMergedConfig,
  configStat: fs.Stats | null,
  localStat: fs.Stats | null,
  machineStat: fs.Stats | null,
  groveStat: fs.Stats | null,
): boolean {
  return (
    cached.configMtimeMs === (configStat?.mtimeMs ?? null)
    && cached.configSize === (configStat?.size ?? null)
    && cached.localMtimeMs === (localStat?.mtimeMs ?? null)
    && cached.localSize === (localStat?.size ?? null)
    && cached.machineMtimeMs === (machineStat?.mtimeMs ?? null)
    && cached.machineSize === (machineStat?.size ?? null)
    && cached.groveMtimeMs === (groveStat?.mtimeMs ?? null)
    && cached.groveSize === (groveStat?.size ?? null)
  );
}

/**
 * Drop any cached merged config for `vaultDir`. Any write path that
 * mutates `myco.yaml` or `local.yaml` calls this so the next read can't
 * serve a stale value before its mtime ticks past the cached one.
 */
export function invalidateMergedConfigCache(vaultDir?: string): void {
  if (vaultDir === undefined) {
    mergedConfigCache.clear();
    return;
  }
  mergedConfigCache.delete(vaultDir);
}

export interface LoadMergedConfigOptions {
  /** Owning Grove id for this load — Grove-tier values come from this Grove. */
  groveId?: string | null;
  /** Override Myco home for tests. */
  mycoHome?: string;
}

/**
 * Build the merged runtime config from the four storage tiers in
 * resolution order: machine → grove → project → personal.
 *
 * Always pass `options.groveId` (from the request context or project manifest)
 * to get a fully-resolved config including Grove-tier agent and embedding
 * values. Pass `groveId: null` explicitly when the caller has confirmed there
 * is no bound Grove.
 *
 * @deprecated Calling without `options.groveId` skips the Grove tier —
 *   Grove-tier fields fall through to schema defaults. Use
 *   `loadMergedConfig(vaultDir, { groveId })` to avoid silent misconfiguration.
 */
export function loadMergedConfig(vaultDir: string, options: LoadMergedConfigOptions = {}): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const localPath = localConfigPath(vaultDir);
  const groveId = options.groveId ?? null;

  // Warn in development when groveId is not provided at all (undefined means
  // the caller didn't think about it; null means "confirmed: no Grove").
  const env = process.env.NODE_ENV;
  if (options.groveId === undefined && env !== 'production' && env !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      '[myco] loadMergedConfig called without groveId — Grove-tier config will be skipped.\n' +
      `  at: ${vaultDir}\n` +
      '  Pass { groveId: requestContext?.groveId ?? null } to include the Grove tier.',
    );
  }
  const mycoHome = options.mycoHome ?? resolveMycoHome();

  const configStat = statOrNull(configPath);
  const localStat = statOrNull(localPath);
  const machinePath = resolveGlobalConfigPath(mycoHome);
  const grovePath = groveId ? resolveGroveConfigPath(groveId, mycoHome) : null;
  const machineStat = statOrNull(machinePath);
  const groveStat = grovePath ? statOrNull(grovePath) : null;

  const cacheKey = `${vaultDir}::${groveId ?? ''}`;
  const cached = mergedConfigCache.get(cacheKey);
  if (cached && fingerprintMatches(cached, configStat, localStat, machineStat, groveStat)) {
    return cached.config;
  }

  // Run pending v2/v3 + numbered + tier-strip migrations on the project
  // file and capture the post-migration sparse doc directly — saves a
  // second read+parse of myco.yaml against disk. Tier migration is
  // opt-in so test fixtures that don't sandbox MYCO_HOME don't
  // contaminate the developer's real ~/.myco/.
  const { parsed: projectRaw } = loadConfigInternal(vaultDir, {
    groveId,
    mycoHome,
    migrateTiers: true,
  });

  const machineRaw = readRawYamlDoc(machinePath);
  const groveRaw = grovePath ? readRawYamlDoc(grovePath) : {};
  const local = loadLocalConfig(vaultDir);

  // Sparse merge — each tier contributes only the keys it explicitly
  // sets. Defaults are filled in by the final Zod parse.
  const stage1 = deepMergeConfig(machineRaw, groveRaw);
  const stage2 = deepMergeConfig(stage1, projectRaw);
  const stage3 = deepMergeConfig(stage2, local as Record<string, unknown>);
  const result = MycoConfigSchema.parse(stage3);

  // Re-stat after load — loadConfig may have written a migrated file back.
  const finalConfigStat = statOrNull(configPath);
  const finalLocalStat = statOrNull(localPath);
  const finalMachineStat = statOrNull(machinePath);
  const finalGroveStat = grovePath ? statOrNull(grovePath) : null;
  mergedConfigCache.set(cacheKey, {
    configMtimeMs: finalConfigStat?.mtimeMs ?? null,
    configSize: finalConfigStat?.size ?? null,
    localMtimeMs: finalLocalStat?.mtimeMs ?? null,
    localSize: finalLocalStat?.size ?? null,
    machineMtimeMs: finalMachineStat?.mtimeMs ?? null,
    machineSize: finalMachineStat?.size ?? null,
    groveMtimeMs: finalGroveStat?.mtimeMs ?? null,
    groveSize: finalGroveStat?.size ?? null,
    config: result,
  });
  return result;
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
  atomicWriteFileSync(localConfigPath(vaultDir), nextYaml, 'utf-8');
  invalidateMergedConfigCache(vaultDir);
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

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';
import {
  MycoConfigSchema,
  MachineConfigSchema,
  ExternalMcpSchema,
  GroveConfigSchema,
  ProjectConfigSchema,
  PROJECT_TIER_LEGACY_FIELDS,
  GROVE_TIER_FIELDS,
  type MycoConfig,
  type MachineConfig,
  type ExternalMcpConfig,
  type GroveConfig,
  type BackupConfig,
} from './schema.js';
import { runMigrations, CURRENT_MIGRATION_VERSION } from './migrations.js';
import { pruneToTier } from './scope.js';
import { EXTERNAL_MCP_DEFAULT_PORT } from '@myco/constants.js';
import { CAPABILITIES } from './capabilities.js';
import { enumerateLeafPaths } from './leaf-paths.js';
import { stripDefaultSections } from './sparse.js';
import { deepMerge } from '../utils/deep-merge.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import {
  resolveGlobalConfigPath,
  resolveGroveConfigPath,
  resolveGroveDir,
  resolveMycoHome,
} from '../grove/paths.js';
import { loadProjectManifest } from './project-manifest.js';

export const CONFIG_FILENAME = 'myco.yaml';
export const LOCAL_CONFIG_FILENAME = 'local.yaml';
const MACHINE_CONFIG_LOCK_FILENAME = 'machine-config.lock';
const EXTERNAL_MCP_PATH = ['daemon', 'external_mcp'] as const;

function localConfigPath(vaultDir: string): string {
  // vaultDir already points at `.myco/` (see resolveVaultDir), so local.yaml
  // sits alongside myco.yaml in the vault — no extra `.myco/` prefix.
  return path.join(vaultDir, LOCAL_CONFIG_FILENAME);
}

/**
 * The project-tier stand-in doc substituted when `myco.yaml` is ABSENT but the
 * caller has opted into tolerating that absence — the optional project tier for
 * a served project's merged read (`loadMergedConfig` `projectTierOptional`), and
 * the attach carve's reads / create-on-write. `version` is the one
 * project-tier-owned literal with no schema default (`config/scope.ts`'s
 * SCOPE_REGISTRY has no other home for it), so the stand-in carries it exactly
 * as every real project file does. Returns a fresh object per call so a caller
 * can never mutate a shared reference into the merge pipeline.
 */
function projectTierStandinDoc(): Record<string, unknown> {
  return { version: 3 };
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

// ---------------------------------------------------------------------------
// Tier parse-failure registry — loud, deduped, observable
// ---------------------------------------------------------------------------
//
// A tier file that exists but can't be honored (corrupt YAML, non-mapping
// root, genuine Zod value violations) silently reverts that tier to defaults.
// Every such failure is logged to stderr (deduped per file+reason per
// process) and reported to an optional listener so the daemon can surface a
// notification. The loader must NOT import the notification layer itself —
// notify() loads merged config, which would recurse straight back here.

const tierParseFailures = new Map<string, string>();
let tierParseFailureListener: ((filePath: string, reason: string) => void) | null = null;

export function setTierParseFailureListener(
  fn: ((filePath: string, reason: string) => void) | null,
): void {
  tierParseFailureListener = fn;
  // Replay failures recorded before registration: tier files are read during
  // daemon boot (config load) before the daemon wires its listener, and the
  // dedupe map would otherwise swallow the very incident the listener exists
  // to surface (a file already corrupt at startup). A file deleted since the
  // failure no longer needs surfacing — drop its record instead.
  if (fn) {
    for (const [filePath, reason] of tierParseFailures) {
      if (!fs.existsSync(filePath)) {
        tierParseFailures.delete(filePath);
        continue;
      }
      fn(filePath, reason);
    }
  }
}

function recordTierParseFailure(filePath: string, reason: string): void {
  if (tierParseFailures.get(filePath) === reason) return;
  tierParseFailures.set(filePath, reason);
  process.stderr.write(`[myco config] Failed to honor ${filePath}: ${reason}\n`);
  tierParseFailureListener?.(filePath, reason);
}

/**
 * Remove every `unrecognized_keys` path reported by a Zod error from `doc`.
 * Returns true when at least one key was removed. Used to salvage tier files
 * that carry unknown keys (e.g. written by a newer Myco version): known
 * values are honored instead of silently reverting the whole tier to
 * defaults.
 */
function stripUnrecognizedKeys(doc: Record<string, unknown>, error: z.ZodError): boolean {
  let stripped = false;
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    for (const key of issue.keys) {
      if (unsetAtPath(doc, [...issue.path.map(String), key])) stripped = true;
    }
  }
  return stripped;
}

function zodReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

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
  let failedThisRead = false;
  const fail = (reason: string): void => {
    failedThisRead = true;
    recordTierParseFailure(filePath, reason);
  };
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
        fail(`invalid YAML — ${(err as Error).message}`);
        result = parseEmpty();
        cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, config: result });
        return result;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('root must be a YAML mapping');
        result = parseEmpty();
      } else {
        try {
          result = parseDoc(parsed);
        } catch (err) {
          // Salvage: unknown keys (strict tier schemas) must not revert the
          // whole tier to defaults — strip them and honor the known values.
          // Only genuine value violations fall back to defaults, loudly.
          result = parseEmpty();
          if (err instanceof z.ZodError) {
            const salvaged = structuredClone(parsed) as Record<string, unknown>;
            if (stripUnrecognizedKeys(salvaged, err)) {
              try {
                result = parseDoc(salvaged);
              } catch (err2) {
                fail(err2 instanceof z.ZodError ? zodReason(err2) : (err2 as Error).message);
              }
            } else {
              fail(zodReason(err));
            }
          } else {
            fail((err as Error).message);
          }
        }
      }
    }
  }
  // A clean read clears the failure record so a later re-corruption of the
  // same file (even with an identical reason) notifies again.
  if (!failedThisRead) tierParseFailures.delete(filePath);
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

/** Fresh strict machine-tier read for recoverable state transitions. */
export function loadMachineConfigStrict(mycoHome = resolveMycoHome()): MachineConfig {
  const filePath = resolveGlobalConfigPath(mycoHome);
  const rawDoc = readRawYamlDocStrict(filePath);
  return parseTierDocTolerant((doc) => MachineConfigSchema.parse(doc), rawDoc);
}

/** Whether the raw machine tier explicitly carries external MCP state. */
export function hasExplicitExternalMcpConfig(mycoHome = resolveMycoHome()): boolean {
  const filePath = resolveGlobalConfigPath(mycoHome);
  return getAtPath(readRawYamlDocStrict(filePath), EXTERNAL_MCP_PATH) !== undefined;
}

/** Fresh strict read of only the raw external MCP machine subtree. */
export function readExplicitExternalMcpConfigStrict(
  mycoHome = resolveMycoHome(),
): ExternalMcpConfig | undefined {
  const filePath = resolveGlobalConfigPath(mycoHome);
  const raw = getAtPath(readRawYamlDocStrict(filePath), EXTERNAL_MCP_PATH);
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ExternalMcpSchema.parse(raw);
  }
  return parseTierDocTolerant(
    (doc) => ExternalMcpSchema.parse(doc),
    raw as Record<string, unknown>,
  );
}

/** Recover a valid raw external MCP port even when a sibling field is invalid. */
export function readRecoverableExternalMcpPortStrict(
  mycoHome = resolveMycoHome(),
): number | undefined {
  const filePath = resolveGlobalConfigPath(mycoHome);
  const raw = getAtPath(readRawYamlDocStrict(filePath), EXTERNAL_MCP_PATH);
  if (!raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || !Object.hasOwn(raw, 'port')) return undefined;
  const parsed = ExternalMcpSchema.shape.port.safeParse(
    (raw as Record<string, unknown>).port,
  );
  return parsed.success ? parsed.data : undefined;
}

export class ProtectedMachineConfigPathError extends Error {
  constructor() {
    super('daemon.external_mcp is managed by the external MCP containment authority');
    this.name = 'ProtectedMachineConfigPathError';
  }
}

function withMachineConfigLock<T>(mycoHome: string, fn: () => T): T {
  return withFileLockSync(
    path.join(mycoHome, '.locks', MACHINE_CONFIG_LOCK_FILENAME),
    fn,
  );
}

export function saveMachineConfig(config: MachineConfig, mycoHome = resolveMycoHome()): void {
  const validated = MachineConfigSchema.parse(config);
  withMachineConfigLock(mycoHome, () => {
    const filePath = resolveGlobalConfigPath(mycoHome);
    const currentRaw = readRawYamlDocStrict(filePath);
    const currentView = parseTierDocTolerant(
      (doc) => MachineConfigSchema.parse(doc),
      currentRaw,
    );
    if (!isDeepStrictEqual(
      validated.daemon.external_mcp,
      currentView.daemon.external_mcp,
    )) {
      throw new ProtectedMachineConfigPathError();
    }

    const nextRaw = structuredClone(validated) as unknown as Record<string, unknown>;
    const currentExternalMcp = getAtPath(currentRaw, EXTERNAL_MCP_PATH);
    if (currentExternalMcp === undefined) {
      unsetAtPath(nextRaw, EXTERNAL_MCP_PATH, { pruneEmptyParents: true });
    } else {
      setAtPath(nextRaw, EXTERNAL_MCP_PATH, structuredClone(currentExternalMcp));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, YAML.stringify(nextRaw), 'utf-8');
    machineConfigCache.delete(filePath);
    invalidateMergedConfigCache();
  });
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
 *
 * The transform receives the Zod-defaulted parsed view; its result is
 * deep-merged onto the RAW on-disk doc so unknown keys survive the write.
 * Deep-merge cannot DELETE keys — callers that need wholesale subtree
 * replacement (e.g. agent.tasks, where task updates remove keys) should use
 * `updateTierConfigRaw` directly with `setAtPath` (verbatim subtree set).
 */
export function updateGroveConfig(
  groveId: string,
  transform: (current: GroveConfig) => GroveConfig,
  opts?: { mycoHome?: string },
): GroveConfig {
  return updateTierConfigRaw({ kind: 'grove', groveId }, (raw) => {
    const current = loadGroveConfig(groveId, opts?.mycoHome);
    const next = transform(current);
    return deepMergeConfig(raw, next as unknown as Record<string, unknown>);
  }, opts);
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

// ---------------------------------------------------------------------------
// Shared raw-merge tier writer — machine + grove
// ---------------------------------------------------------------------------

/**
 * Thrown when a tier file exists, is non-empty, and cannot be parsed as a
 * YAML mapping. Write paths must refuse to proceed (the lenient read path
 * would treat the doc as empty and the subsequent write would wipe the
 * file); API callers surface it as a 422.
 */
export class TierConfigUnreadableError extends Error {
  constructor(public readonly filePath: string, reason: string) {
    super(`On-disk config at ${filePath} is invalid — fix or remove it (${reason})`);
    this.name = 'TierConfigUnreadableError';
  }
}

/** Strict variant of `readRawYamlDoc`: corrupt content throws instead of `{}`. */
function readRawYamlDocStrict(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new TierConfigUnreadableError(filePath, `invalid YAML — ${(err as Error).message}`);
  }
  // A null root (comments-only doc, bare `---`) holds zero YAML values —
  // there is nothing a write could destroy, so treat it as empty rather
  // than unwritable. Array/scalar roots still refuse: they're malformed
  // docs whose content a write WOULD discard.
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TierConfigUnreadableError(filePath, 'root must be a YAML mapping');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate a raw tier doc with unknown keys TOLERATED: parse a deep-cloned
 * copy with `unrecognized_keys` stripped. A pass means the raw doc (unknown
 * keys preserved) is safe to persist; genuine value violations rethrow the
 * ZodError for the caller to surface.
 */
function parseTierDocTolerant<T>(parse: (doc: unknown) => T, rawDoc: Record<string, unknown>): T {
  try {
    return parse(rawDoc);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const stripped = structuredClone(rawDoc);
      if (stripUnrecognizedKeys(stripped, err)) {
        return parse(stripped);
      }
    }
    throw err;
  }
}

export type TierWriteTarget = { kind: 'machine' } | { kind: 'grove'; groveId: string };
export interface TierWriteOptions {
  mycoHome?: string;
  durable?: boolean;
}

export function updateTierConfigRaw(
  target: { kind: 'machine' },
  mutate: (rawDoc: Record<string, unknown>) => Record<string, unknown> | void,
  opts?: TierWriteOptions,
): MachineConfig;
export function updateTierConfigRaw(
  target: { kind: 'grove'; groveId: string },
  mutate: (rawDoc: Record<string, unknown>) => Record<string, unknown> | void,
  opts?: TierWriteOptions,
): GroveConfig;
export function updateTierConfigRaw(
  target: TierWriteTarget,
  mutate: (rawDoc: Record<string, unknown>) => Record<string, unknown> | void,
  opts?: TierWriteOptions,
): MachineConfig | GroveConfig;
/**
 * Canonical write path for machine/grove tier files. Reads the RAW on-disk
 * doc (throwing `TierConfigUnreadableError` rather than wiping a corrupt
 * file), applies `mutate`, validates tolerantly (unknown keys preserved on
 * disk; value violations throw ZodError), persists atomically, and
 * invalidates the tier + merged caches. Returns the Zod-parsed full view —
 * the shape API responses and the UI's PUT-response cache expect.
 */
export function updateTierConfigRaw(
  target: TierWriteTarget,
  mutate: (rawDoc: Record<string, unknown>) => Record<string, unknown> | void,
  opts?: TierWriteOptions,
): MachineConfig | GroveConfig {
  const mycoHome = opts?.mycoHome ?? resolveMycoHome();
  const update = (): MachineConfig | GroveConfig => {
    const filePath = target.kind === 'machine'
      ? resolveGlobalConfigPath(mycoHome)
      : resolveGroveConfigPath(target.groveId, mycoHome);

    const rawDoc = readRawYamlDocStrict(filePath);
    const previousExternalMcp = target.kind === 'machine'
      ? structuredClone(getAtPath(rawDoc, EXTERNAL_MCP_PATH))
      : undefined;
    const nextRaw = mutate(rawDoc) ?? rawDoc;
    if (target.kind === 'machine' && !isDeepStrictEqual(
      previousExternalMcp,
      getAtPath(nextRaw, EXTERNAL_MCP_PATH),
    )) {
      throw new ProtectedMachineConfigPathError();
    }
    const parsedView = target.kind === 'machine'
      ? parseTierDocTolerant((doc) => MachineConfigSchema.parse(doc), nextRaw)
      : parseTierDocTolerant((doc) => GroveConfigSchema.parse(doc), nextRaw);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, YAML.stringify(nextRaw), {
      encoding: 'utf-8',
      durable: opts?.durable,
    });
    if (target.kind === 'machine') machineConfigCache.delete(filePath);
    else groveConfigCache.delete(filePath);
    invalidateMergedConfigCache();
    return parsedView;
  };

  return target.kind === 'machine'
    ? withMachineConfigLock(mycoHome, update)
    : update();
}

export function disableExternalMcpConfig(
  mycoHome = resolveMycoHome(),
  options: { durable?: boolean } = {},
): MachineConfig {
  return withMachineConfigLock(mycoHome, () => {
    const filePath = resolveGlobalConfigPath(mycoHome);
    const rawDoc = readRawYamlDocStrict(filePath);
    const daemon = getAtPath(rawDoc, ['daemon']);
    if (daemon !== undefined && (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon))) {
      throw new TierConfigUnreadableError(filePath, 'daemon must be a YAML mapping');
    }
    const daemonMapping = (daemon ?? {}) as Record<string, unknown>;
    const externalMcp = daemonMapping.external_mcp;
    if (externalMcp !== undefined
      && (externalMcp === null || typeof externalMcp !== 'object' || Array.isArray(externalMcp))) {
      throw new TierConfigUnreadableError(
        filePath,
        'daemon.external_mcp must be a YAML mapping',
      );
    }
    rawDoc.daemon = {
      ...daemonMapping,
      external_mcp: {
        ...(externalMcp as Record<string, unknown> | undefined),
        enabled: false,
      },
    };
    const parsedView = parseTierDocTolerant(
      (doc) => MachineConfigSchema.parse(doc),
      rawDoc,
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, YAML.stringify(rawDoc), {
      encoding: 'utf-8',
      durable: options.durable,
    });
    machineConfigCache.delete(filePath);
    invalidateMergedConfigCache();
    return parsedView;
  });
}

/**
 * The ONE sanctioned enable writer for the protected `daemon.external_mcp`
 * subtree — the activation sibling of {@link disableExternalMcpConfig}.
 * Callable ONLY from the containment-locked enable flow (the containment
 * authority serializes it against every other external-MCP mutation); the
 * general `saveMachineConfig` path still throws on this subtree, and a stale
 * whole-machine snapshot still cannot restore `enabled: true`. Stamps the
 * explicit subtree surgically (raw-doc merge, unknown siblings preserved)
 * and re-parses the result so a malformed doc never lands half-written.
 */
export function enableExternalMcpConfig(
  mycoHome = resolveMycoHome(),
  options: { durable?: boolean } = {},
): MachineConfig {
  return withMachineConfigLock(mycoHome, () => {
    const filePath = resolveGlobalConfigPath(mycoHome);
    const rawDoc = readRawYamlDocStrict(filePath);
    const daemon = getAtPath(rawDoc, ['daemon']);
    if (daemon !== undefined && (daemon === null || typeof daemon !== 'object' || Array.isArray(daemon))) {
      throw new TierConfigUnreadableError(filePath, 'daemon must be a YAML mapping');
    }
    const daemonMapping = (daemon ?? {}) as Record<string, unknown>;
    const externalMcp = daemonMapping.external_mcp;
    if (externalMcp !== undefined
      && (externalMcp === null || typeof externalMcp !== 'object' || Array.isArray(externalMcp))) {
      throw new TierConfigUnreadableError(
        filePath,
        'daemon.external_mcp must be a YAML mapping',
      );
    }
    const existing = externalMcp as Record<string, unknown> | undefined;
    rawDoc.daemon = {
      ...daemonMapping,
      external_mcp: {
        ...existing,
        enabled: true,
        // `port` stays the legacy containment-reconciliation field; the
        // socket path is DERIVED from MYCO_HOME, never configured. Preserve
        // an existing explicit port, else stamp the schema default so the
        // subtree is always explicit (H1: tokenPresent without an explicit
        // subtree is the boot-breaking brownfield state).
        port: isExplicitExternalMcpPort(existing?.port) ? existing.port : EXTERNAL_MCP_DEFAULT_PORT,
      },
    };
    const parsedView = parseTierDocTolerant(
      (doc) => MachineConfigSchema.parse(doc),
      rawDoc,
    );
    if (!parsedView.daemon.external_mcp.enabled) {
      throw new TierConfigUnreadableError(filePath, 'daemon.external_mcp did not verify as enabled');
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, YAML.stringify(rawDoc), {
      encoding: 'utf-8',
      durable: options.durable,
    });
    machineConfigCache.delete(filePath);
    invalidateMergedConfigCache();
    return parsedView;
  });
}

function isExplicitExternalMcpPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

/**
 * Machine-tier field paths that are legacy residue in a project myco.yaml.
 * Shared by `migrateLegacyProjectFields` (the load-path migration) and
 * `relocateMachineFieldsFromProject` (the save-path guard) so both move the
 * exact same set with identical semantics.
 *
 * `daemon.port` is not relocated: the project-tier value is stripped as legacy,
 * and the machine-tier value is set directly in the home's `config.yaml`.
 */
const MACHINE_RELOCATE_FIELDS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [['daemon', 'log_level'], ['daemon', 'log_level']],
  [['daemon', 'log_retention_days'], ['daemon', 'log_retention_days']],
  // 2026-06 settings-scope correction: capture.* and notifications.* → Machine
  // tier. Symbionts are global now, so capture policy is per-machine; notification
  // preferences are a local per-user setting that must never be git-committed.
  [['capture'], ['capture']],
  [['notifications'], ['notifications']],
];

/**
 * Machine-tier relocation pairs handled on the SAVE path: every entry of
 * `MACHINE_RELOCATE_FIELDS` plus the legacy `update.channel` →
 * `daemon.update_channel` lift.
 */
const SAVE_PATH_MACHINE_RELOCATE_FIELDS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  ...MACHINE_RELOCATE_FIELDS,
  [['update', 'channel'], ['daemon', 'update_channel']],
];

/**
 * Relocate machine-tier values (capture/notifications/daemon log fields,
 * legacy update.channel) out of a project save and into machine config —
 * LEAF-WISE, deep-merged into the raw machine doc. Block-level writes would
 * wipe machine-explicit leaves (e.g. `capture.transcript_paths`) whenever a
 * project section relocates over an existing machine section.
 *
 * Per-leaf rule: relocate when the leaf is on-disk residue in myco.yaml OR
 * its value differs from the schema default. When the machine doc already
 * has that exact leaf, the no-clobber stands UNLESS the caller-set value
 * differs from default — the caller wins at leaf granularity, so an
 * explicit `updateConfig` write of a machine-homed leaf actually lands.
 *
 * Returns true when a write to machine config occurred.
 */
function relocateMachineFieldsFromProject(
  validated: Record<string, unknown>,
  onDiskRaw: Record<string, unknown>,
  defaults: Record<string, unknown>,
  mycoHome: string,
): boolean {
  return withMachineConfigLock(mycoHome, () => {
    const machinePath = resolveGlobalConfigPath(mycoHome);
    const machineRaw = readRawYamlDocStrict(machinePath);
    let machineDirty = false;

    for (const [sourcePath, targetPath] of SAVE_PATH_MACHINE_RELOCATE_FIELDS) {
      const value = getAtPath(validated, sourcePath);
      if (value === undefined) continue;

      // Enumerate leaves of section values; scalar/array sources are a single leaf.
      const leafSuffixes = (value !== null && typeof value === 'object' && !Array.isArray(value))
        ? enumerateLeafPaths(value).map((leaf) => leaf.split('.'))
        : [[]];

      for (const suffix of leafSuffixes) {
        const fullSource = [...sourcePath, ...suffix];
        const fullTarget = [...targetPath, ...suffix];
        const leafValue = getAtPath(validated, fullSource);
        if (leafValue === undefined) continue;
        const defaultValue = getAtPath(defaults, fullSource);
        const differsFromDefault = YAML.stringify(leafValue) !== YAML.stringify(defaultValue);
        const onDiskValue = getAtPath(onDiskRaw, fullSource);
        const onDisk = onDiskValue !== undefined;
        if (!onDisk && !differsFromDefault) continue; // defaults aren't meaningful
        if (getAtPath(machineRaw, fullTarget) !== undefined) {
          // A leaf may overwrite an explicit machine value only when the caller
          // changed it in THIS save (differs from the project file's pre-save
          // state). Unchanged on-disk residue never clobbers a machine value —
          // the machine value is the newer intent; the residue is simply
          // dropped from the project file by the schema strip.
          const callerChanged = YAML.stringify(leafValue) !== YAML.stringify(onDiskValue);
          if (!callerChanged) continue;
        }
        setAtPath(machineRaw, fullTarget, leafValue);
        machineDirty = true;
      }
    }

    if (machineDirty) {
      try {
        // Tolerant validation, then persist the RAW doc — unknown keys in the
        // machine file survive the relocation instead of being wiped.
        parseTierDocTolerant((doc) => MachineConfigSchema.parse(doc), machineRaw);
      } catch {
        // Defensive: never corrupt machine storage from a project save.
        return false;
      }
      fs.mkdirSync(path.dirname(machinePath), { recursive: true });
      atomicWriteFileSync(machinePath, YAML.stringify(machineRaw), 'utf-8');
      machineConfigCache.delete(machinePath);
      invalidateMergedConfigCache();
      return true;
    }
    return false;
  });
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
  vaultDir: string,
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

    // Every Grove-tier field that can appear in a legacy project myco.yaml
    // (source path === target path for all entries). Derived from the shared
    // GROVE_TIER_FIELDS export so the lift list can't drift from the strip
    // list — Grove-bind lifts retained values instead of wiping them.
    for (const segments of GROVE_TIER_FIELDS) {
      tryMove(segments, segments);
    }

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
  //
  // Shared field set (daemon log fields + capture + notifications) with the
  // save-path guard (`relocateMachineFieldsFromProject`) so both relocate the
  // exact same paths with identical semantics.
  for (const [sourcePath, targetPath] of MACHINE_RELOCATE_FIELDS) {
    moveMachine(sourcePath, targetPath);
  }
  // `update.channel` from legacy schema → daemon.update_channel.
  // Two legacy homes existed: project myco.yaml (the original per-project
  // schema field) and project local.yaml (the per-project override the
  // retired Operations setter wrote). Decision-46130740 makes the channel
  // machine-scoped, so lift either source to machine ONCE (only when machine
  // has no explicit value yet — idempotent) and strip the now-dead leaf from
  // local.yaml on the way out. myco.yaml's `update` is stripped separately by
  // stripLegacyProjectFields (PROJECT_TIER_LEGACY_FIELDS includes `update`).
  const liftUpdateChannel = (source: unknown): void => {
    if (
      source !== undefined
      && getAtPath(machineRaw, ['daemon', 'update_channel']) === undefined
    ) {
      setAtPath(machineRaw, ['daemon', 'update_channel'], source);
      machineDirty = true;
    }
  };
  liftUpdateChannel(getAtPath(parsed, ['update', 'channel']));

  // Strip + lift the legacy local.yaml override. Read the raw doc so we don't
  // resurrect Zod defaults into the sparse file.
  const localPath = localConfigPath(vaultDir);
  if (fs.existsSync(localPath)) {
    const localRaw = readRawYamlDoc(localPath);
    if (getAtPath(localRaw, ['update', 'channel']) !== undefined) {
      liftUpdateChannel(getAtPath(localRaw, ['update', 'channel']));
      // Remove only the migrated leaf and prune `update` if now empty — a
      // future `update.*` field in local.yaml must survive the strip.
      unsetAtPath(localRaw, ['update', 'channel'], { pruneEmptyParents: true });
      try {
        atomicWriteFileSync(localPath, YAML.stringify(localRaw), 'utf-8');
        invalidateMergedConfigCache(vaultDir);
        moved = true;
      } catch {
        // Non-fatal: the runtime already ignores local.yaml's channel, so a
        // failed strip leaves a dead field but does not change behavior.
      }
    }
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
  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // Typed so write-path callers (scoped PUT, agent-tasks, symbionts patch)
    // surface a 422 instead of a raw YAMLParseError 500. Load-path behavior
    // is unchanged: corrupt myco.yaml has always thrown out of loadConfig.
    throw new TierConfigUnreadableError(configPath, `invalid YAML — ${(err as Error).message}`);
  }
  // Non-mapping roots (null from a comments-only file, scalar, array) have
  // always failed this loader — but as untyped TypeErrors from property
  // access below. Classify them as unreadable so API callers get the same
  // 422 contract as a parse failure. Unlike local.yaml (an optional overlay
  // where a null root is treated as empty), myco.yaml is the project's
  // identity document — a contentless root means it needs repair.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TierConfigUnreadableError(configPath, 'root must be a YAML mapping');
  }

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
    ? migrateLegacyProjectFields(parsed, groveId, mycoHome, vaultDir)
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

/**
 * Load the single project tier, tolerating an ABSENT `myco.yaml` by returning
 * the parsed stand-in skeleton instead of throwing "myco.yaml not found". The
 * non-merged analog of `loadMergedConfig`'s `projectTierOptional`, for the
 * attach carve's single-tier reads (`GET /api/config` and the scoped
 * local-write project validation) whose fresh checkout has no project file yet.
 *
 * Only ABSENCE is tolerated: a PRESENT file is loaded strictly through
 * `loadConfig`, so a malformed present file still throws. Callers on the LOCAL
 * path keep the strict `loadConfig` — this tolerance is opt-in for the attach
 * carve, exactly as `projectTierOptional` is on the merged path.
 */
export function loadConfigOptional(vaultDir: string): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return MycoConfigSchema.parse(projectTierStandinDoc());
  }
  return loadConfig(vaultDir);
}

export function saveConfig(vaultDir: string, config: MycoConfig): void {
  // Validate full shape first (OAK lesson: validate on write, not just
  // read), then filter through ProjectConfigSchema so Grove/Machine-tier
  // fields can't sneak back into the project file. Zod's default strip
  // semantics drop any unknown keys — daemon/backup/update etc. all
  // belong in their own tier files. The returned MycoConfig still has
  // those tiers; we just don't persist them here.
  const validated = MycoConfigSchema.parse(config);
  const projectOnly = ProjectConfigSchema.parse(validated) as Record<string, unknown>;

  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  // Strict read: refuse to overlay-and-write when the on-disk doc is
  // unparseable. updateConfig callers never get here (loadConfig already
  // throws on corrupt myco.yaml); this guards direct saveConfig callers,
  // which would otherwise replace the user's (recoverable) file with a doc
  // built from a config object that never saw the on-disk values.
  const onDiskRaw = readRawYamlDocStrict(configPath);
  const defaults = MycoConfigSchema.parse({ version: 3 });

  // Machine-tier fields (capture/notifications/daemon log fields/legacy
  // update.channel) are dropped by ProjectConfigSchema's strip. The load-path
  // migration (migrateLegacyProjectFields, gated by migrateTiers=true)
  // relocates them to machine config — but updateConfig → loadConfig runs
  // WITHOUT migrateTiers, so an un-migrated project's machine-tier values can
  // reach saveConfig still living in myco.yaml. Were we to only strip them
  // here, the values would be lost: not kept (project), not relocated (the
  // migration never ran). Relocate them on the save path too — leaf-wise, so
  // a relocated section never wipes machine-explicit leaves, and only for
  // MEANINGFUL leaves (on-disk residue OR non-default caller values) so clean
  // saves don't pollute machine config with defaults blocks.
  relocateMachineFieldsFromProject(
    validated as unknown as Record<string, unknown>,
    onDiskRaw,
    defaults as unknown as Record<string, unknown>,
    resolveMycoHome(),
  );

  // Grove-tier fields are dropped by ProjectConfigSchema's strip, but that's
  // only safe once a Grove is bound (the load-path migration relocates them to
  // grove config then). On an UNBOUND project there's no Grove to migrate
  // into, so dropping them here would lose user-set values entirely — neither
  // kept (project) nor migrated (grove). Mirror the load-path deferral
  // (stripLegacyProjectFields skips grove-tier fields when !hasGrove): retain
  // every meaningful GROVE_TIER_FIELDS value in myco.yaml until a Grove is
  // bound. The next Grove-bound load runs migrateLegacyProjectFields to
  // lift + strip them.
  //
  // Meaningful = already persisted on disk OR carrying a non-default value
  // the caller just set — so clean projects aren't polluted with grove-tier
  // defaults blocks (mirrors the sparse-doc semantics: defaults never get
  // written to myco.yaml). Sub-path entries compare at the LEAF, not the
  // section, so stripDefaultSections below doesn't end up keeping
  // default-valued sparse leaves inside an otherwise non-default section.
  const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;
  if (groveId === null) {
    for (const segments of GROVE_TIER_FIELDS) {
      const value = getAtPath(validated as unknown as Record<string, unknown>, segments);
      if (value === undefined) continue; // cleared/optional — nothing to retain
      const defaultValue = getAtPath(defaults as unknown as Record<string, unknown>, segments);
      const onDisk = getAtPath(onDiskRaw, segments) !== undefined;
      // Explicit both-undefined guard: YAML.stringify(undefined) returns
      // undefined, which would make two absent values compare "equal" only
      // by accident — state it directly instead.
      const differsFromDefault = defaultValue === undefined
        ? true
        : YAML.stringify(value) !== YAML.stringify(defaultValue);
      if (onDisk || differsFromDefault) {
        setAtPath(projectOnly, segments, value);
      }
    }
  }

  fs.mkdirSync(vaultDir, { recursive: true });
  // Keep project config sparse. Every current capability gate is fail-open
  // on unset (CapabilityDef.defaultEnabled defaults to true), but a future
  // fail-closed capability (defaultEnabled: false) stays behaviorally
  // identical under this strip too — a section is only stripped when it
  // equals its defaults, so a fail-closed default (resolves closed when
  // stripped) round-trips the same as a fail-open one (resolves open when
  // stripped). A non-default gate value always survives the strip.
  const sparseProject = stripDefaultSections(projectOnly, defaults, ['version', 'config_version']);
  atomicWriteFileSync(configPath, YAML.stringify(sparseProject), 'utf-8');
  invalidateMergedConfigCache(vaultDir);
}

export interface UpdateConfigOptions {
  /**
   * Opt-in create-on-write for an ABSENT `myco.yaml`. When true and the project
   * file does not exist, seed the update from the project-tier stand-in skeleton
   * instead of throwing "myco.yaml not found", then persist through the normal
   * atomic `saveConfig` path — the transform's output IS the newly-created file.
   *
   * Default (false) stays STRICT: a missing file throws exactly as before. This
   * is the single sanctioned config write path (safe-config-updates invariant),
   * so the opt-in extends it rather than adding a second writer. ONLY the
   * attach-carve scoped-write path passes this; every other caller in the
   * monorepo keeps the strict default.
   */
  createIfMissing?: boolean;
}

export function updateConfig(
  vaultDir: string,
  fn: (config: MycoConfig) => MycoConfig,
  options: UpdateConfigOptions = {},
): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const current = (options.createIfMissing === true && !fs.existsSync(configPath))
    ? MycoConfigSchema.parse(projectTierStandinDoc())
    : loadConfig(vaultDir);
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
 * True when the personal overlay file EXISTS, is non-empty, and cannot be
 * honored (YAML parse failure or a non-mapping root). Deliberately separate
 * from `loadLocalConfig`, whose `{}`-on-malformed return contract is pinned
 * by callers — this classifier lets `loadMergedConfig` fail closed without
 * changing that contract. A missing or empty file is NOT unreadable.
 */
function isLocalOverlayUnreadable(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return false;
  try {
    const parsed: unknown = YAML.parse(raw);
    return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    return true;
  }
}

export function migrateLegacyLocalAppearanceToGrove(
  vaultDir: string,
  groveId: string | null,
  mycoHome: string = resolveMycoHome(),
): void {
  if (!groveId) return;
  const filePath = localConfigPath(vaultDir);
  if (!fs.existsSync(filePath)) return;

  const localRaw = readRawYamlDoc(filePath);
  const appearance = getAtPath(localRaw, ['appearance']);
  if (appearance === undefined) return;

  const grovePath = resolveGroveConfigPath(groveId, mycoHome);
  const groveRaw = readRawYamlDoc(grovePath);
  if (getAtPath(groveRaw, ['appearance']) === undefined) {
    setAtPath(groveRaw, ['appearance'], appearance);
    try {
      const validated = GroveConfigSchema.parse(groveRaw);
      saveGroveConfig(groveId, validated, mycoHome);
    } catch {
      // Keep the no-local-appearance invariant even if the legacy value
      // cannot be lifted into Grove config.
    }
  }

  unsetAtPath(localRaw, ['appearance'], { pruneEmptyParents: true });
  atomicWriteFileSync(filePath, YAML.stringify(localRaw), 'utf-8');
  invalidateMergedConfigCache(vaultDir);
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
  // Entries are keyed `${vaultDir}::${groveId ?? ''}` — drop every Grove
  // variant for this vault.
  for (const key of mergedConfigCache.keys()) {
    if (key === vaultDir || key.startsWith(`${vaultDir}::`)) {
      mergedConfigCache.delete(key);
    }
  }
}

export interface LoadMergedConfigOptions {
  /** Owning Grove id for this load — Grove-tier values come from this Grove. */
  groveId?: string | null;
  /** Override Myco home for tests. */
  mycoHome?: string;
  /**
   * Tolerate a missing project-tier file: when true and `myco.yaml` does not
   * exist in `vaultDir`, the project tier contributes nothing to the merge
   * instead of throwing "myco.yaml not found". Machine, grove, and personal
   * tiers still resolve normally from their own paths (none of which read
   * the project's working tree). For callers iterating a registered project
   * whose working tree isn't present on this machine (a Team Host serving a
   * member's project) — a project WITH a present `myco.yaml` is unaffected
   * by this flag either way.
   */
  projectTierOptional?: boolean;
}

/**
 * Build the merged runtime config from the four storage tiers in
 * resolution order: machine → grove → project → personal.
 *
 * `groveId` resolves in this order:
 *   1. `options.groveId` if explicitly passed (including explicit `null` for
 *      "confirmed: no bound Grove")
 *   2. The project's bound Grove from `<vaultDir>/.myco/project.toml`
 *   3. `null` (no Grove tier merged) when neither is available
 *
 * Callers in request-handling contexts (daemon API handlers) should pass
 * `groveId` from the request context — that's the authoritative source when
 * the user has switched projects via the UI. Callers operating on a single
 * vault directory (CLI, internal helpers) can omit it and the manifest is
 * consulted automatically.
 */
export function loadMergedConfig(vaultDir: string, options: LoadMergedConfigOptions = {}): MycoConfig {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const localPath = localConfigPath(vaultDir);
  const groveId = options.groveId !== undefined
    ? options.groveId
    : (loadProjectManifest(vaultDir)?.grove?.id ?? null);
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const projectTierOptional = options.projectTierOptional === true;

  const configStat = statOrNull(configPath);
  const localStat = statOrNull(localPath);
  const machinePath = resolveGlobalConfigPath(mycoHome);
  const grovePath = groveId ? resolveGroveConfigPath(groveId, mycoHome) : null;
  const machineStat = statOrNull(machinePath);
  const groveStat = grovePath ? statOrNull(grovePath) : null;

  // The optional-project-tier mode caches separately from the normal mode —
  // otherwise a tolerant read (empty project tier) and a throwing read of the
  // same absent `myco.yaml` would share a cache entry keyed only on the
  // (matching, both-null) file stat, letting the tolerant result silently
  // paper over what should still be a throw when the caller didn't opt in.
  const cacheKey = `${vaultDir}::${groveId ?? ''}${projectTierOptional ? '::optional' : ''}`;
  const cached = mergedConfigCache.get(cacheKey);
  if (cached && fingerprintMatches(cached, configStat, localStat, machineStat, groveStat)) {
    return cached.config;
  }

  // Run pending v2/v3 + numbered + tier-strip migrations on the project
  // file and capture the post-migration sparse doc directly — saves a
  // second read+parse of myco.yaml against disk. Tier migration is
  // opt-in so test fixtures that don't sandbox MYCO_HOME don't
  // contaminate the developer's real ~/.myco/.
  //
  // `projectTierOptional` skips this entirely when the file is absent: the
  // project tier contributes nothing to the merge rather than throwing, and
  // there is nothing on disk to migrate or write back. `version` is still
  // required — it's a project-tier-owned literal with no schema default
  // (`config/scope.ts`'s SCOPE_REGISTRY has no other home for it) — so the
  // stand-in doc carries it exactly as every real project file does.
  const projectRaw = (projectTierOptional && !configStat)
    ? projectTierStandinDoc()
    : loadConfigInternal(vaultDir, { groveId, mycoHome, migrateTiers: true }).parsed;

  migrateLegacyLocalAppearanceToGrove(vaultDir, groveId, mycoHome);
  const machineRaw = readRawYamlDoc(machinePath);
  const groveRaw = grovePath ? readRawYamlDoc(grovePath) : {};
  const local = loadLocalConfig(vaultDir);

  // Scope-aware sparse merge — each tier contributes only the leaves the
  // scope registry assigns to it. A stray field in a tier that doesn't own
  // it is dropped before merge, so it can't override the real owner. This
  // replaces the project-tier merge-time denylist with a systematic
  // allowlist driven by SCOPE_REGISTRY. Defaults are filled in by the final
  // Zod parse.
  const stage1 = deepMergeConfig(pruneToTier(machineRaw, 'machine'), pruneToTier(groveRaw, 'grove'));
  const stage2 = deepMergeConfig(stage1, pruneToTier(projectRaw, 'project'));
  const stage3 = deepMergeConfig(stage2, pruneToTier(local as Record<string, unknown>, 'local'));

  // Fail closed when the personal overlay exists but can't be honored.
  // local.yaml is where capability OFF-gates live (capture-only projects);
  // loadLocalConfig returns {} for a corrupt file, which would silently
  // re-enable every capability (`capabilityEnabled` is `!== false`). Force
  // every capability master gate off until the file is fixed or removed.
  if (isLocalOverlayUnreadable(localPath)) {
    for (const capability of Object.values(CAPABILITIES)) {
      setAtPath(stage3, capability.masterGate.split('.'), false);
    }
    recordTierParseFailure(
      localPath,
      'personal overlay is unreadable — all capabilities forced off until it is fixed or removed',
    );
  } else {
    // A readable overlay clears the failure record so re-corruption notifies.
    tierParseFailures.delete(localPath);
  }

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
 * Fetch the host's raw grove-tier config doc for an attached project. Resolving
 * to `null` (or rejecting) means the host is unreachable — the grove tier then
 * degrades to defaults (see {@link loadAttachedMergedConfig}). Never reads local
 * disk: for an attached project there is no local grove config file.
 */
export type AttachedGroveDocFetcher = () => Promise<Record<string, unknown> | null>;

export interface LoadAttachedMergedConfigOptions {
  /**
   * Source the HOST's grove-tier config doc — the ONE tier not read from the
   * member's local disk. Everything else (machine, project, personal) resolves
   * locally, so the member's machine-tier mechanics never resolve from the
   * host (routing-layer §6.3, guardrail 3 "no cross-machine config resolution").
   */
  fetchGroveDoc: AttachedGroveDocFetcher;
  /** Override Myco home for tests. */
  mycoHome?: string;
  /**
   * Fired once when the grove fetch fails or returns null, so the caller can
   * warn once-per-host rather than on every read. The loader NEVER throws out
   * of the degrade path — a merged view still renders with grove-tier defaults.
   */
  onGroveUnreachable?: (err: unknown) => void;
}

/**
 * The attached-project counterpart to {@link loadMergedConfig}: build the merged
 * runtime config for a project served by a remote host. Machine, project, and
 * personal tiers resolve from the member's LOCAL disk exactly as
 * `loadMergedConfig` does; only the **grove** tier is host-sourced (via
 * `fetchGroveDoc`) instead of read from a local grove config file that does not
 * exist for an attached project.
 *
 * This is NOT a fork of `loadMergedConfig` — it composes the same primitives it
 * does (`loadConfigInternal` for the project doc, `readRawYamlDoc` for machine,
 * `loadLocalConfig` for personal, `pruneToTier` + `deepMergeConfig` for the
 * staged merge, the `isLocalOverlayUnreadable` fail-closed guard, and the final
 * `MycoConfigSchema.parse`) with exactly one substitution: the grove raw doc.
 *
 * Host-unreachable degrades cleanly: a null/throwing `fetchGroveDoc` falls back
 * to grove-tier defaults (`{}` → filled by the final schema parse) and fires
 * `onGroveUnreachable` once so the caller can warn — it never hangs (the fetch
 * seam owns its own timeout) and never serves a stale-wrong grove tier silently.
 *
 * Tier migration is deliberately OFF (`migrateTiers: false`, `groveId: null`):
 * an attached project must never materialize a local grove config file for its
 * hosted Grove. Grove-tier residue in the project's `myco.yaml` is dropped by
 * `pruneToTier(projectRaw, 'project')` regardless, so it cannot leak into the
 * project tier's contribution.
 */
export async function loadAttachedMergedConfig(
  vaultDir: string,
  options: LoadAttachedMergedConfigOptions,
): Promise<MycoConfig> {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  const localPath = localConfigPath(vaultDir);
  const machinePath = resolveGlobalConfigPath(mycoHome);

  // Project tier — LOCAL. No local-grove materialization for the hosted Grove.
  // A fresh clone-then-attach has no `myco.yaml` yet, so tolerate its ABSENCE
  // exactly as loadMergedConfig's projectTierOptional path does
  // (BEHAVE-LIKE-LOCAL): the project tier contributes only the stand-in
  // `version` rather than throwing "myco.yaml not found". Gate on file absence
  // (the member HAS the working tree, so `projectTreeAvailable` is the wrong
  // signal) — a PRESENT-but-malformed file still throws, surfacing as the
  // attached_config_failed envelope, because corruption is not absence.
  const projectRaw = !fs.existsSync(configPath)
    ? projectTierStandinDoc()
    : loadConfigInternal(vaultDir, {
        groveId: null,
        mycoHome,
        migrateTiers: false,
      }).parsed;

  // Machine tier — LOCAL (the member's own machine mechanics), never the host's.
  const machineRaw = readRawYamlDoc(machinePath);

  // Grove tier — HOST-sourced; unreachable degrades to defaults + a once-warn.
  let groveRaw: Record<string, unknown> = {};
  try {
    const fetched = await options.fetchGroveDoc();
    if (fetched && typeof fetched === 'object' && !Array.isArray(fetched)) {
      groveRaw = fetched;
    } else {
      options.onGroveUnreachable?.(null);
    }
  } catch (err) {
    options.onGroveUnreachable?.(err);
  }

  // Personal tier — LOCAL (`.myco/local.yaml`, per-machine, not git-committed).
  const local = loadLocalConfig(vaultDir);

  // Scope-aware sparse merge, identical staging to loadMergedConfig
  // (machine → grove → project → personal); each tier contributes only the
  // leaves the scope registry assigns it.
  const stage1 = deepMergeConfig(pruneToTier(machineRaw, 'machine'), pruneToTier(groveRaw, 'grove'));
  const stage2 = deepMergeConfig(stage1, pruneToTier(projectRaw, 'project'));
  const stage3 = deepMergeConfig(stage2, pruneToTier(local as Record<string, unknown>, 'local'));

  // Fail closed on an unreadable personal overlay — same contract as
  // loadMergedConfig: a corrupt local.yaml forces every capability master gate
  // off until it is fixed, rather than silently re-enabling everything.
  if (isLocalOverlayUnreadable(localPath)) {
    for (const capability of Object.values(CAPABILITIES)) {
      setAtPath(stage3, capability.masterGate.split('.'), false);
    }
    recordTierParseFailure(
      localPath,
      'personal overlay is unreadable — all capabilities forced off until it is fixed or removed',
    );
  } else {
    tierParseFailures.delete(localPath);
  }

  return MycoConfigSchema.parse(stage3);
}

/**
 * Write local.yaml only when the serialized contents differ from `current`.
 * Skips the write (and mkdirSync) on a no-op to avoid noisy file mtimes.
 *
 * Strict-read gate: `current` comes from the lenient `loadLocalConfig`, which
 * salvages an unparseable file as `{}` — building a write on that salvage
 * would replace whatever the corrupt file held with just the caller's patch.
 * Re-read the on-disk doc strictly and throw `TierConfigUnreadableError`
 * before any write, mirroring the machine/grove raw-writer contract.
 */
function writeLocalYamlIfChanged<T>(vaultDir: string, current: T, next: T): T {
  readRawYamlDocStrict(localConfigPath(vaultDir));
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

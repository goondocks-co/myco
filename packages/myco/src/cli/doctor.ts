/**
 * CLI: myco doctor — check vault health and auto-repair fixable issues.
 *
 * Runs a series of health checks against the vault directory and reports
 * status. With --fix, attempts to repair issues it can handle automatically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findCorePackageRoot } from '../utils/find-package-root.js';
import { getPluginVersion } from '../version.js';
import { readDaemonState, resolveDaemonServiceState } from '../daemon/service-state.js';
import {
  createDaemonStateAuthority,
  type StateMutationLogger,
} from '../daemon/daemon-state-authority.js';
import { resolveProjectRoot } from '../vault/resolve.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { isProcessAlive } from './shared.js';
import { MYCO_MCP_SERVER_NAME } from '../symbionts/installer.js';
import { isMycoHookGroup } from '../symbionts/install-helpers.js';
import { manifestToolTransport } from '../symbionts/capabilities.js';
import { expandHome } from '../grove/paths.js';
import type { ServiceStatus } from '../service/types.js';

// --- Named constants (no magic literals) ---


/** Filename of the vault config file. */
const CONFIG_FILENAME = 'myco.yaml';

/** Filename of the daemon state file. */
/** Filename of the SQLite database. */
const DB_FILENAME = 'myco.db';

/** Column width for the check name in output. */
const NAME_COL_WIDTH = 17;

/** Prefix for indented continuation lines (e.g. multi-line agent output). */
const CONTINUATION_INDENT = ' '.repeat(NAME_COL_WIDTH);

/** Marker embedded in Myco-managed plugin-file hook targets (Pi, opencode). */
const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';

// --- Types ---

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  fixable: boolean;
}

// --- Checks ---

/** Check that myco.yaml exists and parses. Returns the parsed config on success. */
async function checkVault(vaultDir: string): Promise<{ check: DoctorCheck; config: import('../config/schema.js').MycoConfig | null }> {
  const configPath = path.join(vaultDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { check: { name: 'Vault', status: 'fail', detail: `${CONFIG_FILENAME} not found in ${vaultDir}`, fixable: false }, config: null };
  }
  try {
    const { loadMergedConfig } = await import('../config/loader.js');
    const groveId = loadProjectManifest(vaultDir)?.grove?.id ?? null;
    const config = loadMergedConfig(vaultDir, { groveId });
    return { check: { name: 'Vault', status: 'ok', detail: `.myco/ (v${config.version})`, fixable: false }, config };
  } catch (err) {
    return { check: { name: 'Vault', status: 'fail', detail: `${CONFIG_FILENAME} parse error: ${(err as Error).message}`, fixable: false }, config: null };
  }
}

/** Check that the SQLite database exists and can be queried. */
async function checkDatabase(vaultDir: string): Promise<DoctorCheck> {
  const { resolveDaemonDataPaths } = await import('@myco/daemon/data-paths.js');
  const { databasePath, usingGrove } = resolveDaemonDataPaths(vaultDir);
  if (!fs.existsSync(databasePath)) {
    const hint = usingGrove
      ? `Grove DB not found at ${databasePath}`
      : `${DB_FILENAME} not found — start the Myco daemon to initialize it (\`myco service start\`)`;
    return { name: 'Database', status: 'fail', detail: hint, fixable: false };
  }
  try {
    const { initDatabase, closeDatabase } = await import('../db/client.js');
    const db = initDatabase(databasePath);
    const row = db.prepare('SELECT count(*) AS cnt FROM sessions').get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    closeDatabase();
    const label = usingGrove ? 'Grove DB' : DB_FILENAME;
    return { name: 'Database', status: 'ok', detail: `${label} (${count.toLocaleString()} sessions)`, fixable: false };
  } catch (err) {
    // Ensure DB is closed even on error
    try { const { closeDatabase } = await import('../db/client.js'); closeDatabase(); } catch { /* ignore */ }
    return { name: 'Database', status: 'fail', detail: `Database error: ${(err as Error).message}`, fixable: false };
  }
}

/** Sessions newer than this count as "capture is flowing". */
const CAPTURE_FRESH_WINDOW_DAYS = 7;

/** Human-readable age of an epoch-seconds timestamp, e.g. "3d ago". */
function formatSessionAge(epochSeconds: number | null): string {
  if (!epochSeconds) return 'never';
  const deltaSec = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (deltaSec < 3600) return 'within the hour';
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}

/**
 * Report whether capture is actually FLOWING, not just whether the DB exists.
 * `checkDatabase` reports a total session count; this answers the question a
 * user with a memory tool most wants answered — "is my work being captured?"
 *
 * A vault that has sessions but none recently is the silent-capture-loss
 * signature (the daemon stopped, hooks aren't firing, a symbiont got
 * disabled) — exactly the failure mode that has recurred in this project and
 * that nothing surfaced before. A brand-new vault with zero sessions is
 * healthy, not alarming.
 */
export async function checkCaptureFlow(vaultDir: string): Promise<DoctorCheck> {
  try {
    const { resolveDaemonDataPaths } = await import('@myco/daemon/data-paths.js');
    // Resolved inside the try: an unbound/half-provisioned vault makes
    // request-context resolution throw, and a diagnostic must never crash
    // the whole `myco doctor` run.
    const { databasePath } = resolveDaemonDataPaths(vaultDir);
    if (!fs.existsSync(databasePath)) {
      // checkDatabase already reports the missing-DB failure in detail; keep
      // this row quiet-but-honest rather than duplicating the alarm.
      return { name: 'Capture', status: 'warn', detail: 'No database yet — start the daemon (`myco service start`)', fixable: false };
    }
    const { initDatabase, closeDatabase } = await import('../db/client.js');
    const db = initDatabase(databasePath);
    const total = (db.prepare('SELECT count(*) AS c FROM sessions').get() as { c: number }).c;
    const last = (db.prepare('SELECT max(started_at) AS t FROM sessions').get() as { t: number | null }).t;
    const windowStart = Math.floor(Date.now() / 1000) - CAPTURE_FRESH_WINDOW_DAYS * 86_400;
    const recent = (db.prepare('SELECT count(*) AS c FROM sessions WHERE started_at >= ?').get(windowStart) as { c: number }).c;
    closeDatabase();

    if (total === 0) {
      return { name: 'Capture', status: 'ok', detail: 'No sessions captured yet — open a project in your agent to begin', fixable: false };
    }
    if (recent > 0) {
      return { name: 'Capture', status: 'ok', detail: `${recent} session${recent === 1 ? '' : 's'} in the last ${CAPTURE_FRESH_WINDOW_DAYS} days (last ${formatSessionAge(last)})`, fixable: false };
    }
    return { name: 'Capture', status: 'warn', detail: `No sessions in the last ${CAPTURE_FRESH_WINDOW_DAYS} days (last ${formatSessionAge(last)}) — if you've been working, capture may not be flowing; check the Symbionts page`, fixable: false };
  } catch (err) {
    try { const { closeDatabase } = await import('../db/client.js'); closeDatabase(); } catch { /* ignore */ }
    return { name: 'Capture', status: 'fail', detail: `Capture check failed: ${(err as Error).message}`, fixable: false };
  }
}

/** Check that the intelligence (agent) provider is configured. */
async function checkIntelligence(config: import('../config/schema.js').MycoConfig): Promise<DoctorCheck> {
  try {
    const provider = config.agent.provider;

    if (!provider) {
      return { name: 'Intelligence', status: 'warn', detail: 'No agent provider configured — open the Myco dashboard and configure under Settings', fixable: false };
    }

    const label = `${provider.type}${provider.model ? ` / ${provider.model}` : ''}`;

    if (provider.type === 'anthropic') {
      return { name: 'Intelligence', status: 'ok', detail: `${label} (SDK handles auth)`, fixable: false };
    }

    // Local provider — check reachability
    if (provider.type === 'ollama' || provider.type === 'lmstudio') {
      const { checkLocalProvider } = await import('../intelligence/provider-check.js');
      const status = await checkLocalProvider(provider.type, provider.base_url);
      if (!status.available) {
        return { name: 'Intelligence', status: 'warn', detail: `${label} (not reachable)`, fixable: false };
      }
      return { name: 'Intelligence', status: 'ok', detail: label, fixable: false };
    }

    return { name: 'Intelligence', status: 'ok', detail: label, fixable: false };
  } catch (err) {
    return { name: 'Intelligence', status: 'fail', detail: `Intelligence check failed: ${(err as Error).message}`, fixable: false };
  }
}

/** Check that the embedding provider is configured and reachable. */
async function checkEmbeddings(config: import('../config/schema.js').MycoConfig): Promise<DoctorCheck> {
  try {
    const { createEmbeddingProvider } = await import('../intelligence/llm.js');
    const provider = createEmbeddingProvider(config.embedding);
    const available = await provider.isAvailable();
    const label = `${config.embedding.provider} / ${config.embedding.model}`;
    if (available) {
      return { name: 'Embeddings', status: 'ok', detail: label, fixable: false };
    }
    return { name: 'Embeddings', status: 'warn', detail: `${label} (not reachable)`, fixable: false };
  } catch (err) {
    return { name: 'Embeddings', status: 'fail', detail: `Embedding check failed: ${(err as Error).message}`, fixable: false };
  }
}

/** Check symbiont detection and registration status. */
async function checkAgents(vaultDir: string, config: import('../config/schema.js').MycoConfig | null): Promise<DoctorCheck[]> {
  try {
    const { detectSymbionts } = await import('../symbionts/detect.js');
    const { getEnabledSymbiontNames } = await import('../config/loader.js');
    const projectRoot = resolveProjectRoot(vaultDir);
    const detected = detectSymbionts(projectRoot);

    const enabledNames = config ? getEnabledSymbiontNames(config) : null;

    if (detected.length === 0 && !enabledNames) {
      return [{ name: 'Agents', status: 'warn', detail: 'No symbionts detected', fixable: false }];
    }

    const checks: DoctorCheck[] = [];
    for (const d of detected) {
      const registered = isSymbiontRegistered(d, projectRoot);
      const enabled = enabledNames ? enabledNames.has(d.manifest.name) : registered;

      if (enabled && registered) {
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'ok',
          detail: `${d.manifest.displayName} (enabled, registered)`,
          fixable: false,
        });
      } else if (enabled && !registered && isSymbiontRegisteredGlobally(d)) {
        // Opted IN via the `symbionts:` block but no project-scope config:
        // the global-install migration strips project config and capture
        // runs through the global agent install. Reporting "not registered"
        // here is a false alarm whose `myco update` remedy just re-runs the
        // strip — so when the global install is present, this is healthy.
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'ok',
          detail: `${d.manifest.displayName} (enabled, registered globally)`,
          fixable: false,
        });
      } else if (enabled && !registered) {
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'warn',
          detail: `${d.manifest.displayName} (enabled but not registered — run \`myco update\`)`,
          fixable: false,
        });
      } else if (!enabled && registered) {
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'warn',
          detail: `${d.manifest.displayName} (registered but not enabled — run \`myco remove --symbiont ${d.manifest.name}\`)`,
          fixable: false,
        });
      } else {
        // Detected but neither enabled nor registered
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'ok',
          detail: `${d.manifest.displayName} (detected, not enabled)`,
          fixable: false,
        });
      }
    }

    if (checks.length === 0) {
      return [{ name: 'Agents', status: 'warn', detail: 'No symbionts detected or enabled', fixable: false }];
    }

    return checks;
  } catch (err) {
    return [{ name: 'Agents', status: 'fail', detail: `Agent check failed: ${(err as Error).message}`, fixable: false }];
  }
}

/** Check if a symbiont has Myco registration artifacts installed. */
export function isSymbiontRegistered(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  projectRoot: string,
): boolean {
  const registration = d.manifest.registration;
  if (!registration) return false;

  // cli-transport symbionts intentionally have no MCP server; their hook
  // registration is the source of truth (same as Pi/Windsurf, which omit
  // mcpTarget). Without this, doctor falsely reports "enabled but not
  // registered" and the suggested `myco update` can't fix it (it correctly
  // writes no MCP server).
  if (manifestToolTransport(d.manifest) === 'cli') {
    if (registration.hooksTarget) {
      return isHooksRegisteredAt(d, path.join(projectRoot, registration.hooksTarget));
    }
    return false;
  }

  // Most symbionts have native MCP registration. For agents like Pi and
  // Windsurf that intentionally omit mcpTarget, treat their hook/plugin
  // registration as the source of truth instead of forcing a false warning.
  if (registration.mcpTarget) {
    return isMcpRegisteredAt(d, path.join(projectRoot, registration.mcpTarget), registration.mcpTarget);
  }
  if (registration.hooksTarget) {
    return isHooksRegisteredAt(d, path.join(projectRoot, registration.hooksTarget));
  }
  return false;
}

/**
 * Check if Myco is wired into a symbiont's GLOBAL agent config
 * (`~/.claude/...`, etc.). Under the global-install model this is where
 * capture is actually configured — project-scope config is stripped by the
 * migration. Used to suppress the false "enabled but not registered" warning
 * for projects that opted a symbiont IN via the `symbionts:` block: they are
 * still captured through the global install, and the warning's suggested
 * `myco update` would only re-run the strip.
 */
export function isSymbiontRegisteredGlobally(
  d: import('../symbionts/detect.js').DetectedSymbiont,
): boolean {
  const registration = d.manifest.registration;
  if (!registration) return false;
  // cli-transport symbionts have no global MCP server either; their global
  // hook registration is the source of truth. Mirrors the project-scope gate
  // in isSymbiontRegistered so the global suppression path doesn't fall
  // through to globalMcpTarget and miss the (correctly absent) MCP server.
  if (manifestToolTransport(d.manifest) === 'cli') {
    if (registration.globalHooksTarget
      && isHooksRegisteredAt(d, expandHome(registration.globalHooksTarget))) {
      return true;
    }
    return false;
  }
  // globalMcpTarget can be a string or an array of string/object entries;
  // only the simple-string shape is checked here. The global hooks target is
  // the reliable cross-agent signal, so an exotic MCP shape just falls
  // through to it rather than this check trying to model every variant.
  const globalMcp = registration.globalMcpTarget;
  if (typeof globalMcp === 'string'
    && isMcpRegisteredAt(d, expandHome(globalMcp), globalMcp)) {
    return true;
  }
  if (registration.globalHooksTarget
    && isHooksRegisteredAt(d, expandHome(registration.globalHooksTarget))) {
    return true;
  }
  return false;
}

function isMcpRegisteredAt(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  mcpFile: string,
  mcpTarget: string,
): boolean {
  try {
    const raw = fs.readFileSync(mcpFile, 'utf-8');

    // TOML: check for section header
    if (mcpTarget.endsWith('.toml')) {
      return raw.includes(`[mcp_servers.${MYCO_MCP_SERVER_NAME}]`);
    }

    // JSON: check for server entry under the configured key (defaults to 'mcpServers').
    // opencode uses 'mcp' — without the manifest lookup, doctor reports opencode as
    // unregistered even after a successful install.
    const config = JSON.parse(raw) as Record<string, unknown>;
    const serversKey = d.manifest.registration?.mcpServersKey ?? 'mcpServers';
    const servers = config[serversKey] as Record<string, unknown> | undefined;
    return !!servers?.[MYCO_MCP_SERVER_NAME];
  } catch { /* config missing or malformed */ }
  return false;
}

function isHooksRegisteredAt(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  hooksFile: string,
): boolean {
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');

    if (d.manifest.registration?.hooksFormat === 'plugin-file') {
      return raw.includes(MYCO_PLUGIN_FILE_MARKER);
    }

    const config = JSON.parse(raw) as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown[]> | undefined;
    if (!hooks) return false;

    return Object.values(hooks).some((groups) =>
      Array.isArray(groups) &&
      groups.some((group) =>
        typeof group === 'object' &&
        group !== null &&
        isMycoHookGroup(group as Record<string, unknown>),
      ),
    );
  } catch { /* config missing or malformed */ }
  return false;
}

/** Check the daemon state file and process liveness. */
/**
 * Compare the running binary's baked version (`getPluginVersion()`, set at
 * compile time via `setPluginVersion(pkg.version)`) against the package.json
 * sitting next to the binary on disk. They diverge when an upgrade refreshed
 * the package files but not the platform-specific compiled binary — a class
 * of bug that has historically silently broken `myco --version` and masked
 * stale code running in the daemon. See PR #263 incident postmortem.
 */
function checkBinaryVersionSkew(): DoctorCheck {
  const baked = getPluginVersion();
  // Walk up from the binary to @goondocks/myco core — that's the manifest
  // npm install actually shipped. (Source checkouts find packages/myco/.)
  const argv0 = process.argv[0];
  const installedRoot = argv0 ? findCorePackageRoot(path.dirname(argv0)) : null;
  if (!installedRoot) {
    return { name: 'Binary version', status: 'warn', detail: `binary baked at ${baked}; could not find installed package.json to compare`, fixable: false };
  }
  let installedVersion = '';
  try {
    installedVersion = (JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf-8')) as { version?: string }).version ?? '';
  } catch (err) {
    return { name: 'Binary version', status: 'warn', detail: `binary baked at ${baked}; could not read installed package.json: ${(err as Error).message}`, fixable: false };
  }
  if (!installedVersion) {
    return { name: 'Binary version', status: 'warn', detail: `binary baked at ${baked}; installed package.json has no version`, fixable: false };
  }
  if (installedVersion !== baked) {
    return {
      name: 'Binary version',
      status: 'fail',
      detail: `installed package.json says ${installedVersion} but binary --version reports ${baked} (npm upgrade refreshed JS but not the compiled binary; reinstall with \`npm install -g @goondocks/myco@${installedVersion}\` to fix)`,
      fixable: false,
    };
  }
  return { name: 'Binary version', status: 'ok', detail: baked, fixable: false };
}

async function checkDaemon(vaultDir: string): Promise<DoctorCheck> {
  const daemonFile = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
  if (!fs.existsSync(daemonFile)) {
    return { name: 'Daemon', status: 'warn', detail: 'Not running (no daemon state)', fixable: false };
  }
  try {
    const state = readDaemonState(daemonFile);
    if (!state) {
      return { name: 'Daemon', status: 'warn', detail: 'daemon state exists but no PID', fixable: true };
    }
    if (!state.pid) {
      return { name: 'Daemon', status: 'warn', detail: 'daemon state exists but no PID', fixable: true };
    }
    if (isProcessAlive(state.pid)) {
      return { name: 'Daemon', status: 'ok', detail: `PID ${state.pid}, port ${state.port ?? 'unknown'}`, fixable: false };
    }
    return { name: 'Daemon', status: 'warn', detail: `Stale daemon.json (PID ${state.pid} not running)`, fixable: true };
  } catch (err) {
    return { name: 'Daemon', status: 'fail', detail: `daemon state parse error: ${(err as Error).message}`, fixable: true };
  }
}


export function evaluateServiceCheck(
  label: string,
  status: ServiceStatus,
  expectedExecutable: string,
): DoctorCheck {
  if (!status.installed) {
    return {
      name: 'Service',
      status: 'warn',
      detail: `${label} not installed — run \`myco service install\` to auto-start at login`,
      fixable: true,
    };
  }
  if (!fs.existsSync(expectedExecutable)) {
    return {
      name: 'Service',
      status: 'fail',
      detail: `${label} executable not found: ${expectedExecutable} (last exit code ${status.lastExitCode ?? 'unknown'} — EX_CONFIG=78 means stale path) — run \`myco service install\` to repair`,
      fixable: true,
    };
  }
  if (status.lastExitCode !== null && status.lastExitCode !== 0) {
    return {
      name: 'Service',
      status: 'warn',
      detail: `${label} last exit code ${status.lastExitCode} (running=${status.running}) — check ${status.unitPath ?? 'service unit'} logs`,
      fixable: false,
    };
  }
  if (!status.running) {
    return {
      name: 'Service',
      status: 'warn',
      detail: `${label} installed but not running — run \`myco service start\``,
      fixable: false,
    };
  }
  return {
    name: 'Service',
    status: 'ok',
    detail: `${label} running (pid ${status.pid ?? '?'}) via ${status.unitPath ?? 'service unit'}`,
    fixable: false,
  };
}

async function checkService(): Promise<DoctorCheck> {
  const { getServiceManager } = await import('../service/manager.js');
  const { serviceLabel } = await import('../service/labels.js');
  const { detectInstallVariant, resolveServiceExecutable } = await import('./service.js');
  const mgr = getServiceManager();
  if (!mgr.supported) {
    return { name: 'Service', status: 'warn', detail: `unsupported platform (${mgr.platformName}) — daemon uses lazy spawn`, fixable: false };
  }
  const variant = detectInstallVariant();
  const label = serviceLabel(variant);
  const status = await mgr.status(label);
  return evaluateServiceCheck(label, status, resolveServiceExecutable(variant));
}

// --- Public API ---

/** Run all health checks against a vault directory. */
export async function runChecks(vaultDir: string): Promise<DoctorCheck[]> {
  const { check: vaultCheck, config } = await checkVault(vaultDir);
  const checks: DoctorCheck[] = [vaultCheck];

  if (!config) {
    checks.push(
      { name: 'Database', status: 'fail', detail: 'Skipped (vault check failed)', fixable: false },
      { name: 'Intelligence', status: 'fail', detail: 'Skipped (vault check failed)', fixable: false },
      { name: 'Embeddings', status: 'fail', detail: 'Skipped (vault check failed)', fixable: false },
      { name: 'Agents', status: 'fail', detail: 'Skipped (vault check failed)', fixable: false },
      await checkDaemon(vaultDir),
    );
    return checks;
  }

  checks.push(await checkDatabase(vaultDir));
  checks.push(await checkCaptureFlow(vaultDir));
  checks.push(await checkIntelligence(config));
  checks.push(await checkEmbeddings(config));
  checks.push(...await checkAgents(vaultDir, config));
  checks.push(await checkDaemon(vaultDir));
  checks.push(await checkService());
  checks.push(checkBinaryVersionSkew());
  checks.push(await checkGlobalLaunchers());
  checks.push(...await checkDetectedSymbionts());
  checks.push(...await checkSymbiontEdgeCases());
  checks.push(...await checkMigrationStatus(vaultDir));

  return checks;
}

/**
 * Global launcher health: `~/.myco/launcher.cjs` and
 * `~/.myco/mcp-launcher.cjs` exist and are non-empty. Their absence is
 * the signal that drives the daemon's first-start auto-bootstrap; once
 * the daemon has come up at least once they must be present, so a
 * missing launcher here is a real failure mode (recover by restarting
 * the daemon, which re-runs the first-start bootstrap and rewrites the
 * launchers).
 */
async function checkGlobalLaunchers(): Promise<DoctorCheck> {
  const { resolveMycoHome } = await import('../grove/paths.js');
  const mycoHome = resolveMycoHome();
  const launcherPath = path.join(mycoHome, 'launcher.cjs');
  const mcpLauncherPath = path.join(mycoHome, 'mcp-launcher.cjs');
  const launcherOk = fs.existsSync(launcherPath) && fs.statSync(launcherPath).size > 0;
  const mcpOk = fs.existsSync(mcpLauncherPath) && fs.statSync(mcpLauncherPath).size > 0;
  if (launcherOk && mcpOk) {
    return { name: 'Launchers', status: 'ok', detail: `${mycoHome}/launcher.cjs + mcp-launcher.cjs`, fixable: false };
  }
  return {
    name: 'Launchers',
    status: 'fail',
    detail: 'Global launchers missing. Restart the daemon (`myco restart`) to re-write them.',
    fixable: false,
  };
}

/**
 * Per-symbiont detection summary. One row per agent whose `detectionDir`
 * is present, marked ok if Myco's global config is wired in.
 */
async function checkDetectedSymbionts(): Promise<DoctorCheck[]> {
  const { loadManifests, resolvePackageRoot } = await import('../symbionts/detect.js');
  const { SymbiontInstaller } = await import('../symbionts/installer.js');
  const pkgRoot = resolvePackageRoot();
  const rows: DoctorCheck[] = [];
  for (const manifest of loadManifests()) {
    const installer = new SymbiontInstaller(manifest, '/', pkgRoot, false, undefined, null, 'global');
    if (!installer.isAvailableForScope()) continue;
    rows.push({
      name: rows.length === 0 ? 'Symbionts' : '',
      status: 'ok',
      detail: `${manifest.displayName} detected`,
      fixable: false,
    });
  }
  if (rows.length === 0) {
    rows.push({
      name: 'Symbionts',
      status: 'warn',
      detail: 'No coding agents detected on this machine.',
      fixable: false,
    });
  }
  return rows;
}

/**
 * Detect known broken-edge states across the global symbiont surface.
 * Emits one row per issue found, plus a final OK row when nothing matched.
 *
 * Checks:
 *   - cursor-cd-cwd: a shell-cd prefix in `~/.cursor/settings.json`
 *     commands (Cursor's hook spawn drops stdin on shell operators).
 *   - claude-matcher: hook groups in `~/.claude/settings.json` missing
 *     the `matcher` field (Cursor cross-reads this file and rejects all
 *     Claude hooks when one group is malformed).
 *   - hybrid-TOML: `~/.codex/config.toml` whose first non-blank char is
 *     `{` instead of TOML (Codex silently disables all hooks).
 *   - project-local stub: orphan `<project>/.agents/myco-run.cjs` with
 *     no sibling `.myco/myco.yaml`.
 */
export async function checkSymbiontEdgeCases(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const home = process.env.HOME ?? '/';
  let isFirst = true;
  const emit = (status: DoctorCheck['status'], detail: string, fixable = false): void => {
    checks.push({ name: isFirst ? 'Edge cases' : '', status, detail, fixable });
    isFirst = false;
  };

  // 1. cursor-cd-cwd
  const cursorHooks = path.join(home, '.cursor', 'settings.json');
  try {
    const raw = fs.readFileSync(cursorHooks, 'utf-8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, Array<{ command?: unknown; hooks?: Array<{ command?: unknown }> }>> };
    const commands: string[] = [];
    for (const groups of Object.values(parsed.hooks ?? {})) {
      for (const group of groups) {
        if (typeof group.command === 'string') commands.push(group.command);
        for (const inner of group.hooks ?? []) {
          if (typeof inner.command === 'string') commands.push(inner.command);
        }
      }
    }
    if (commands.some((cmd) => /cd\s+"\$\{[A-Z_]+:-\.\}"\s*&&/.test(cmd))) {
      emit('fail', `Cursor hooks contain a shell-cd prefix at ${cursorHooks} — drops stdin and breaks capture. Run \`myco doctor --fix\` to rewrite.`);
    }
  } catch { /* file absent or malformed */ }

  // 2. claude-matcher
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(claudeSettings, 'utf-8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, Array<Record<string, unknown>>> };
    const missing: string[] = [];
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (let i = 0; i < groups.length; i++) {
        if (!('matcher' in groups[i]!)) missing.push(`${event}[${i}]`);
      }
    }
    if (missing.length > 0) {
      emit('fail', `Claude hook groups missing \`matcher\` field (Cursor cross-parser rejects whole file): ${missing.join(', ')}. Run \`myco doctor --fix\` to rewrite.`);
    }
  } catch { /* missing or malformed — checkAgents covers parse failure */ }

  // 3. stale escaped smoke-launcher hooks in global agent config
  try {
    const { listEscapedSmokeLauncherTargets, scrubEscapedSmokeLaunchers } = await import('../grove/global-config-migration.js');
    for (const target of listEscapedSmokeLauncherTargets(home)) {
      const outcome = scrubEscapedSmokeLaunchers(target, { apply: false });
      if (outcome.error || outcome.entriesRemoved === 0) continue;
      emit('warn', `Stale escaped smoke-launcher hooks in ${target} (${outcome.entriesRemoved} group(s)). Run \`myco doctor --fix\` to scrub them.`, true);
    }
  } catch { /* best effort */ }

  // 4. hybrid-TOML in codex
  const codexConfig = path.join(home, '.codex', 'config.toml');
  try {
    const raw = fs.readFileSync(codexConfig, 'utf-8').trim();
    if (raw.startsWith('{')) {
      emit('fail', `${codexConfig} starts with JSON, not TOML. Codex silently disables hooks. Run \`myco doctor --fix\` to rewrite.`);
    }
  } catch { /* absent — fine */ }

  // 5. project-local stub orphans — walk registered project roots and
  // surface any whose `.agents/myco-run.cjs` exists without a sibling
  // `.myco/myco.yaml`. Bounded to projects the registry already tracks
  // so we don't scan the filesystem.
  try {
    const { listGroves, listRegisteredProjects } = await import('../grove/registry.js');
    const orphans: string[] = [];
    for (const grove of listGroves()) {
      for (const project of listRegisteredProjects(grove.id)) {
        const stub = path.join(project.root, '.agents', 'myco-run.cjs');
        const vaultConfig = path.join(project.root, '.myco', 'myco.yaml');
        if (fs.existsSync(stub) && !fs.existsSync(vaultConfig)) {
          orphans.push(project.root);
        }
      }
    }
    if (orphans.length > 0) {
      emit('warn', `Orphan project-local launcher stubs (no \`.myco/myco.yaml\`): ${orphans.join(', ')}. Run \`myco remove --project <root>\` to clean up.`);
    }
  } catch { /* registry unavailable — silent */ }

  if (checks.length === 0) {
    checks.push({ name: 'Edge cases', status: 'ok', detail: 'No known broken-edge states detected.', fixable: false });
  }
  return checks;
}

/**
 * Migration walker status. Migration is fire-once-per-project; failures
 * persist in the bounded audit log until either (a) a successful retry
 * via `myco doctor --fix` clears them, or (b) the project is
 * unregistered. Emits one per-project warning per unresolved error so
 * the user can see exactly which root needs attention.
 *
 * Returns an array — the caller spreads into the doctor check list.
 */
export async function checkMigrationStatus(vaultDir: string): Promise<DoctorCheck[]> {
  const { getDatabase, initDatabase, closeDatabase } = await import('../db/client.js');
  const { latestMigrationSummary, listMigrationErrors } = await import('../db/queries/migration-log.js');
  // Prefer an already-initialized DB connection (test harness via
  // `withDatabase`). Fall back to opening the daemon's DB by path when
  // the CLI is invoked cold and no connection is registered.
  let db: ReturnType<typeof getDatabase>;
  let openedHere = false;
  try {
    db = getDatabase();
  } catch {
    const { resolveDaemonDataPaths } = await import('@myco/daemon/data-paths.js');
    let databasePath: string;
    try {
      ({ databasePath } = resolveDaemonDataPaths(vaultDir));
    } catch {
      return [{ name: 'Migration', status: 'ok', detail: 'No migration walker passes yet (greenfield install).', fixable: false }];
    }
    if (!fs.existsSync(databasePath)) {
      return [{ name: 'Migration', status: 'ok', detail: 'No migration walker passes yet (greenfield install).', fixable: false }];
    }
    db = initDatabase(databasePath);
    openedHere = true;
  }
  try {
    const summary = latestMigrationSummary(db);
    const errors = listMigrationErrors(db);
    if (openedHere) closeDatabase();
    if (!summary && errors.length === 0) {
      return [{ name: 'Migration', status: 'ok', detail: 'No migration walker passes yet (greenfield install).', fixable: false }];
    }
    if (errors.length > 0) {
      const out: DoctorCheck[] = [];
      let isFirst = true;
      for (const row of errors) {
        const root = row.project_root ?? row.affected_project_id ?? '<unknown>';
        let message = 'Unknown error.';
        try {
          const parsed = JSON.parse(row.details) as { error?: string };
          if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
            message = parsed.error;
          }
        } catch { /* malformed row — fall through with default message */ }
        out.push({
          name: isFirst ? 'Migration' : '',
          status: 'warn',
          detail: `Migration failed for project ${root}: ${message}. Retry with \`myco doctor --fix\`.`,
          fixable: true,
        });
        isFirst = false;
      }
      return out;
    }
    if (summary) {
      const details = JSON.parse(summary.details) as { projects_visited: number; projects_cleaned: number };
      return [{
        name: 'Migration',
        status: 'ok',
        detail: `Last pass cleaned ${details.projects_cleaned}/${details.projects_visited} project(s).`,
        fixable: false,
      }];
    }
    return [{ name: 'Migration', status: 'ok', detail: 'No issues recorded.', fixable: false }];
  } catch (err) {
    if (openedHere) { try { closeDatabase(); } catch { /* ignore */ } }
    return [{
      name: 'Migration',
      status: 'warn',
      detail: `Could not read migration log: ${err instanceof Error ? err.message : String(err)}`,
      fixable: false,
    }];
  }
}

/** Auto-repair fixable issues. Returns descriptions of actions taken. */
export async function fix(vaultDir: string, checks: DoctorCheck[]): Promise<string[]> {
  const actions: string[] = [];
  const service = resolveDaemonServiceState(vaultDir, { env: process.env });
  const authority = createDaemonStateAuthority(service, doctorLogger());

  for (const check of checks) {
    if (!check.fixable || check.status === 'ok') continue;

    // Fix stale daemon.json — re-read under the authority and only
    // unlink if the recorded pid still matches the pid we observed as
    // dead. If a concurrent successor wrote into the gap, the unlink
    // is a no-op and the file is preserved.
    if (check.name === 'Daemon' && check.detail.includes('Stale')) {
      const staleMatch = check.detail.match(/PID (\d+) not running/);
      const stalePid = staleMatch ? Number(staleMatch[1]) : NaN;
      if (Number.isFinite(stalePid)) {
        const outcome = authority.deleteIfOwnedBy(stalePid, { reason: 'doctor:stale' });
        actions.push(
          outcome === 'deleted'
            ? `Removed stale daemon state (PID ${stalePid})`
            : `Daemon state already refreshed by a successor (was PID ${stalePid}) — no action`,
        );
      }
    }

    // Fix malformed daemon.json — by definition the file was unparseable
    // when the check ran. The authority re-reads under the same
    // discipline: if a successor refreshed the file between detection
    // and fix, leave it alone.
    if (check.name === 'Daemon' && check.detail.includes('parse error')) {
      const outcome = authority.deleteIfMalformed({ reason: 'doctor:malformed' });
      actions.push(
        outcome === 'deleted'
          ? 'Removed malformed daemon state'
          : 'Daemon state already refreshed by a successor — no action',
      );
    }

    // Advise on database issues — the daemon initializes the DB on
    // first start, so restarting it is the canonical recovery path.
    if (check.name === 'Database' && check.status === 'fail') {
      actions.push('Start the Myco daemon (`myco service start`) to initialize the database');
    }
  }

  // Migration retry — re-run the project-local → global walker. The
  // walker is the same code path the daemon's first-start bootstrap
  // uses; the audit-log writer deduplicates so previously-erroring
  // projects that now succeed have their error rows dropped, and
  // projects still failing get their error rows refreshed in place.
  //
  // Driven by the presence of any fixable Migration check (surfaced by
  // checkMigrationStatus). Walks the full set rather than per-project
  // so the audit log stays consistent — a project that succeeds this
  // pass has its prior error row removed, not preserved alongside the
  // new outcome.
  const staleSmokeChecks = checks.filter(
    (c) => c.fixable && c.detail.includes('Stale escaped smoke-launcher hooks'),
  );
  if (staleSmokeChecks.length > 0) {
    try {
      const { runGlobalConfigMigration } = await import('../grove/global-config-migration.js');
      const result = runGlobalConfigMigration();
      const repaired = result.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && !outcome.error);
      const failed = result.outcomes.filter((outcome) => outcome.entriesRemoved > 0 && outcome.error);
      for (const outcome of repaired) {
        actions.push(`Scrubbed ${outcome.entriesRemoved} stale smoke-launcher hook group(s) from ${outcome.filePath}`);
      }
      for (const outcome of failed) {
        actions.push(`Failed to scrub stale smoke-launcher hooks from ${outcome.filePath}: ${outcome.error}`);
      }
      if (repaired.length === 0 && failed.length === 0) {
        actions.push('No stale smoke-launcher hooks remained to scrub');
      }
    } catch (err) {
      actions.push(`Smoke-launcher scrub failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const migrationChecks = checks.filter((c) => c.name === 'Migration' && c.fixable);
  if (migrationChecks.length > 0) {
    try {
      const { runGlobalInstallMigrationPass } = await import('../grove/global-install-migration.js');
      const { recordMigrationPass } = await import('../db/queries/migration-log.js');
      const { getDatabase } = await import('../db/client.js');
      const beforeRoots = new Set<string>();
      for (const c of migrationChecks) {
        const match = c.detail.match(/project ([^:]+):/);
        if (match) beforeRoots.add(match[1]!);
      }
      const result = runGlobalInstallMigrationPass();
      recordMigrationPass(getDatabase(), result);
      const errorsByRoot = new Map<string, string>();
      for (const outcome of result.outcomes) {
        if (outcome.error) errorsByRoot.set(outcome.projectRoot, outcome.error);
      }
      for (const root of beforeRoots) {
        if (errorsByRoot.has(root)) {
          actions.push(`Retried migration for ${root}: still failing: ${errorsByRoot.get(root)}`);
        } else {
          actions.push(`Retried migration for ${root}: succeeded`);
        }
      }
    } catch (err) {
      actions.push(`Migration retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return actions;
}

/** Console-bound logger shim for doctor invocations. The authority's
 *  structured mutation events are only useful at debug time; surface
 *  them on stderr so a `--fix` run reports what it did without
 *  requiring the daemon logger machinery. */
function doctorLogger(): StateMutationLogger {
  return {
    info: (event, message, meta) => {
      const detail = meta ? ` ${JSON.stringify(meta)}` : '';
      console.error(`[doctor] ${event} ${message}${detail}`);
    },
  };
}

// --- Output formatting ---

/** Status label width (visible characters). */
const STATUS_COL_WIDTH = 6;

const STATUS_LABELS: Record<DoctorCheck['status'], { text: string; color: string }> = {
  ok: { text: 'ok', color: '\x1b[32m' },
  fail: { text: 'FAIL', color: '\x1b[31m' },
  warn: { text: '!!', color: '\x1b[33m' },
};

function formatCheck(check: DoctorCheck): string {
  const name = check.name ? check.name.padEnd(NAME_COL_WIDTH) : CONTINUATION_INDENT;
  const { text, color } = STATUS_LABELS[check.status];
  const paddedText = text.padEnd(STATUS_COL_WIDTH);
  return `  ${name}${color}${paddedText}\x1b[0m${check.detail}`;
}

// --- CLI entry point ---

export async function run(args: string[], vaultDir: string): Promise<void> {
  const shouldFix = args.includes('--fix');

  console.log('\nmyco doctor\n');

  const checks = await runChecks(vaultDir);

  for (const check of checks) {
    console.log(formatCheck(check));
  }

  const issues = checks.filter(c => c.status !== 'ok');
  const fixable = issues.filter(c => c.fixable);

  console.log('');

  if (issues.length === 0) {
    console.log('  All checks passed.\n');
    return;
  }

  console.log(`  ${issues.length} issue(s) found.`);

  if (shouldFix) {
    const actions = await fix(vaultDir, checks);
    if (actions.length > 0) {
      console.log('');
      for (const action of actions) {
        console.log(`  Fixed: ${action}`);
      }
      console.log('');
    } else {
      console.log('  No auto-fixable issues.\n');
    }
  } else if (fixable.length > 0) {
    console.log(`  Run \`myco doctor --fix\` to repair ${fixable.length} fixable issue(s).\n`);
  } else {
    console.log('');
  }
}

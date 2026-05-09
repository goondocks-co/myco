/**
 * CLI: myco doctor — check vault health and auto-repair fixable issues.
 *
 * Runs a series of health checks against the vault directory and reports
 * status. With --fix, attempts to repair issues it can handle automatically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readDaemonState, resolveDaemonServiceState } from '../daemon/service-state.js';
import { resolveProjectRoot } from '../vault/resolve.js';
import { isProcessAlive } from './shared.js';
import { MYCO_MCP_SERVER_NAME } from '../symbionts/installer.js';
import { isMycoHookGroup } from '../symbionts/install-helpers.js';

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
    const config = loadMergedConfig(vaultDir);
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
      : `${DB_FILENAME} not found — run \`myco init\``;
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

/** Check that the intelligence (agent) provider is configured. */
async function checkIntelligence(config: import('../config/schema.js').MycoConfig): Promise<DoctorCheck> {
  try {
    const provider = config.agent.provider;

    if (!provider) {
      return { name: 'Intelligence', status: 'warn', detail: 'No agent provider configured — run `myco init` to set up', fixable: false };
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

  // Most symbionts have native MCP registration. For agents like Pi and
  // Windsurf that intentionally omit mcpTarget, treat their hook/plugin
  // registration as the source of truth instead of forcing a false warning.
  if (registration.mcpTarget) {
    return isMcpRegistered(d, projectRoot, registration.mcpTarget);
  }
  if (registration.hooksTarget) {
    return isHooksRegistered(d, projectRoot, registration.hooksTarget);
  }
  return false;
}

function isMcpRegistered(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  projectRoot: string,
  mcpTarget: string,
): boolean {
  try {
    const mcpFile = path.join(projectRoot, mcpTarget);
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

function isHooksRegistered(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  projectRoot: string,
  hooksTarget: string,
): boolean {
  try {
    const hooksFile = path.join(projectRoot, hooksTarget);
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
  checks.push(await checkIntelligence(config));
  checks.push(await checkEmbeddings(config));
  checks.push(...await checkAgents(vaultDir, config));
  checks.push(await checkDaemon(vaultDir));

  return checks;
}

/** Auto-repair fixable issues. Returns descriptions of actions taken. */
export async function fix(vaultDir: string, checks: DoctorCheck[]): Promise<string[]> {
  const actions: string[] = [];

  for (const check of checks) {
    if (!check.fixable || check.status === 'ok') continue;

    // Fix stale daemon.json
    if (check.name === 'Daemon' && check.detail.includes('Stale')) {
      const daemonFile = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
      fs.unlinkSync(daemonFile);
      actions.push('Removed stale daemon state');
    }

    // Fix malformed daemon.json
    if (check.name === 'Daemon' && check.detail.includes('parse error')) {
      const daemonFile = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
      fs.unlinkSync(daemonFile);
      actions.push('Removed malformed daemon state');
    }

    // Advise on database issues
    if (check.name === 'Database' && check.status === 'fail') {
      actions.push('Run `myco init` to initialize the database');
    }
  }

  return actions;
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

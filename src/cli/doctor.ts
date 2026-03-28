/**
 * CLI: myco doctor — check vault health and auto-repair fixable issues.
 *
 * Runs a series of health checks against the vault directory and reports
 * status. With --fix, attempts to repair issues it can handle automatically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './shared.js';
import { MYCO_MCP_SERVER_NAME, MYCO_VAULT_DIR_ENV } from '../symbionts/installer.js';

// --- Named constants (no magic literals) ---


/** Filename of the vault config file. */
const CONFIG_FILENAME = 'myco.yaml';

/** Filename of the daemon state file. */
const DAEMON_STATE_FILENAME = 'daemon.json';

/** Filename of the SQLite database. */
const DB_FILENAME = 'myco.db';

/** Column width for the check name in output. */
const NAME_COL_WIDTH = 17;

/** Prefix for indented continuation lines (e.g. multi-line agent output). */
const CONTINUATION_INDENT = ' '.repeat(NAME_COL_WIDTH);

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
    const { loadConfig } = await import('../config/loader.js');
    const config = loadConfig(vaultDir);
    return { check: { name: 'Vault', status: 'ok', detail: `.myco/ (v${config.version})`, fixable: false }, config };
  } catch (err) {
    return { check: { name: 'Vault', status: 'fail', detail: `${CONFIG_FILENAME} parse error: ${(err as Error).message}`, fixable: false }, config: null };
  }
}

/** Check that the SQLite database exists and can be queried. */
async function checkDatabase(vaultDir: string): Promise<DoctorCheck> {
  const dbPath = path.join(vaultDir, DB_FILENAME);
  if (!fs.existsSync(dbPath)) {
    return { name: 'Database', status: 'fail', detail: `${DB_FILENAME} not found — run \`myco init\``, fixable: false };
  }
  try {
    const { initDatabase, closeDatabase, vaultDbPath } = await import('../db/client.js');
    const db = initDatabase(vaultDbPath(vaultDir));
    const row = db.prepare('SELECT count(*) AS cnt FROM sessions').get() as { cnt: number } | undefined;
    const count = row?.cnt ?? 0;
    closeDatabase();
    return { name: 'Database', status: 'ok', detail: `${DB_FILENAME} (${count.toLocaleString()} sessions)`, fixable: false };
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

    if (provider.type === 'cloud') {
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
async function checkAgents(vaultDir: string): Promise<DoctorCheck[]> {
  try {
    const { detectSymbionts } = await import('../symbionts/detect.js');
    const { resolveVaultDir } = await import('../vault/resolve.js');
    const projectRoot = path.dirname(resolveVaultDir());
    const detected = detectSymbionts(projectRoot);

    if (detected.length === 0) {
      return [{ name: 'Agents', status: 'warn', detail: 'No symbionts detected', fixable: false }];
    }

    const checks: DoctorCheck[] = [];
    for (const d of detected) {
      const registered = isSymbiontRegistered(d, projectRoot);
      if (registered) {
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'ok',
          detail: `${d.manifest.displayName} (registered)`,
          fixable: false,
        });
      } else {
        checks.push({
          name: checks.length === 0 ? 'Agents' : '',
          status: 'warn',
          detail: `${d.manifest.displayName} (detected but not registered)`,
          fixable: true,
        });
      }
    }
    return checks;
  } catch (err) {
    return [{ name: 'Agents', status: 'fail', detail: `Agent check failed: ${(err as Error).message}`, fixable: false }];
  }
}

/** Check if a symbiont has MYCO_VAULT_DIR configured in its settings/MCP config. */
function isSymbiontRegistered(
  d: import('../symbionts/detect.js').DetectedSymbiont,
  projectRoot: string,
): boolean {
  try {
    if (d.manifest.settingsPath) {
      const settingsFile = path.join(projectRoot, d.manifest.settingsPath);
      if (!fs.existsSync(settingsFile)) return false;
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
      const env = settings.env as Record<string, string> | undefined;
      return !!env?.MYCO_VAULT_DIR;
    }

    if (d.manifest.registration?.mcpTarget) {
      const mcpFile = path.join(projectRoot, d.manifest.registration.mcpTarget);
      if (!fs.existsSync(mcpFile)) return false;
      const config = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as Record<string, unknown>;
      const servers = config.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
      return !!servers?.[MYCO_MCP_SERVER_NAME]?.env?.[MYCO_VAULT_DIR_ENV];
    }
  } catch { /* config missing or malformed */ }
  return false;
}

/** Check the daemon state file and process liveness. */
async function checkDaemon(vaultDir: string): Promise<DoctorCheck> {
  const daemonFile = path.join(vaultDir, DAEMON_STATE_FILENAME);
  if (!fs.existsSync(daemonFile)) {
    return { name: 'Daemon', status: 'warn', detail: 'Not running (no daemon.json)', fixable: false };
  }
  try {
    const state = JSON.parse(fs.readFileSync(daemonFile, 'utf-8')) as { pid?: number; port?: number };
    if (!state.pid) {
      return { name: 'Daemon', status: 'warn', detail: 'daemon.json exists but no PID', fixable: true };
    }
    if (isProcessAlive(state.pid)) {
      return { name: 'Daemon', status: 'ok', detail: `PID ${state.pid}, port ${state.port ?? 'unknown'}`, fixable: false };
    }
    return { name: 'Daemon', status: 'warn', detail: `Stale daemon.json (PID ${state.pid} not running)`, fixable: true };
  } catch (err) {
    return { name: 'Daemon', status: 'fail', detail: `daemon.json parse error: ${(err as Error).message}`, fixable: true };
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
  checks.push(...await checkAgents(vaultDir));
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
      const daemonFile = path.join(vaultDir, DAEMON_STATE_FILENAME);
      fs.unlinkSync(daemonFile);
      actions.push('Removed stale daemon.json');
    }

    // Fix malformed daemon.json
    if (check.name === 'Daemon' && check.detail.includes('parse error')) {
      const daemonFile = path.join(vaultDir, DAEMON_STATE_FILENAME);
      fs.unlinkSync(daemonFile);
      actions.push('Removed malformed daemon.json');
    }

    // Advise on agent registration
    if ((check.name === 'Agents' || check.name === '') && check.detail.includes('not registered')) {
      actions.push('Run `myco init` to register detected agents');
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

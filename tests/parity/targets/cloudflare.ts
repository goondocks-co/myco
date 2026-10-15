import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Database } from 'bun:sqlite';
import { renderMigrationFile, renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { devSession } from './dev-session.ts';
import { parityWranglerConfig } from '@myco/server/deploy-config.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { GITHUB_SUB, MACHINE_ID, MEMBER_ID, PROJECT_ID, SESSION_SECRET, grantHeadersFor, memberHeadersFor, type ParityTarget } from '../harness.ts';

const SERVER_DIR = path.resolve(import.meta.dir, '..', '..', '..', 'packages', 'myco-server');
const require = createRequire(path.join(SERVER_DIR, 'package.json'));
const WRANGLER = path.resolve(path.dirname(require.resolve('wrangler')), '..', 'bin', 'wrangler.js');
export const PARITY_TELEMETRY_ALIASES = ['./telemetry.js', '../telemetry.js', '../../telemetry.js', '../../../telemetry.js'] as const;
let session: ReturnType<typeof devSession> | undefined;
export async function stopCloudflareRuntime(): Promise<void> {
  try { await session?.close(); }
  finally { session = undefined; }
}

// Every spawned process, killed at exit: a beforeAll timeout aborts the hook
// without running the target's stop(), and a live wrangler dev with piped
// stdio holds the CI job to its full timeout.
const SPAWNED = new Set<ReturnType<typeof Bun.spawn>>();
process.on('exit', () => {
  for (const proc of SPAWNED) {
    try { proc.kill(); } catch { /* already gone */ }
  }
});

async function wrangler(args: string[], env: Record<string, string | undefined> = {}): Promise<string> {
  const proc = Bun.spawn(['node', WRANGLER, ...args], {
    cwd: os.tmpdir(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  SPAWNED.add(proc);
  const timer = setTimeout(() => { proc.kill(); }, 120_000);
  let code: number, out: string, err: string;
  try {
    [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  } finally { clearTimeout(timer); SPAWNED.delete(proc); }
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${code}: ${[err, out].filter(Boolean).join('\n').slice(-4000)}`);
  return out;
}

/** The derived config with its `main` pointed at another entry; the shipped entry when none is named. */
export function entryConfig(config: string, main: string | undefined): string {
  if (main === undefined) return config;
  const pattern = /^main = ".*"$/m;
  if (!pattern.test(config)) throw new Error('the derived wrangler config names no main entry to replace');
  return config.replace(pattern, `main = ${JSON.stringify(main)}`);
}

/** How many times a `d1 execute` refused by the file lock is asked again. */
export const LOCKED_RETRIES = 5;
/** The first backoff; each retry waits twice the last. */
export const LOCKED_BACKOFF_MS = 100;
const SQL_PROGRESS_INTERVAL_MS = 30_000;

/**
 * How long to wait before asking again, or null to raise what the command said.
 *
 * The dev worker holds the local D1 file, and a `d1 execute` issued while it is
 * writing is refused rather than queued. Every other failure is the scenario's
 * to see at once.
 */
export function lockedRetryWaitMs(said: string, attempt: number): number | null {
  const locked = /database is locked|SQLITE_BUSY/i.test(said);
  if (!locked || attempt >= LOCKED_RETRIES) return null;
  return LOCKED_BACKOFF_MS * 2 ** attempt;
}

/** What a scenario that needs its own boot may change about the Worker it runs against. */
export interface CloudflareBootOptions {
  /** The Worker entry, relative to `packages/myco-server`, in place of the shipped `src/index.ts`. */
  main?: string;
  /** Apply the latest migration to a seeded database at the preceding schema step. */
  latestSchemaUpgrade?: boolean;
}

function schemaObjects(db: Database): Array<{ type: string; name: string; sql: string }> {
  return db.query(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'd1_migrations' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string }>;
}

function expectedSchema(files: ReturnType<typeof renderMigrationFiles>): ReturnType<typeof schemaObjects> {
  const db = new Database(':memory:');
  try {
    for (const file of files) db.exec(file.sql);
    return schemaObjects(db);
  } finally { db.close(); }
}

function tableRows(db: Database, tables: string[]): Record<string, string> {
  return Object.fromEntries(tables.map((table) => {
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return [table, '<absent>'];
    const rows = db.query(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row)).sort();
    return [table, JSON.stringify(rows)];
  }));
}

function assertUpgradeState(databaseFile: string, version: number, expected: ReturnType<typeof schemaObjects>, expectedRows: Record<string, string> = {}): void {
  const db = new Database(databaseFile);
  try {
    const actualVersion = Number((db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value);
    if (actualVersion !== version) throw new Error(`D1 upgrade fixture expected schema ${version}, got ${actualVersion}`);
    const applied = Number((db.query('SELECT COUNT(*) AS count FROM d1_migrations').get() as { count: number }).count);
    if (applied !== version) throw new Error(`D1 upgrade fixture expected ${version} applied Wrangler migrations, got ${applied}`);
    const actual = schemaObjects(db);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const first = actual.findIndex((item, index) => JSON.stringify(item) !== JSON.stringify(expected[index]));
      throw new Error(`D1 upgrade fixture schema objects differ at version ${version}: ${JSON.stringify({ actual: actual[first], expected: expected[first], actualCount: actual.length, expectedCount: expected.length })}`);
    }
    const rows = db.query("SELECT e.event_id, e.producer_adapter, s.session_id, r.id AS run_id, c.event_type FROM events e JOIN sessions s ON s.project_id = e.project_id AND s.session_id = e.session_id JOIN agent_runs r ON r.project_id = e.project_id JOIN agent_run_events c ON c.project_id = r.project_id AND c.run_id = r.id WHERE e.event_id = 'upgrade_event'").all();
    if (JSON.stringify(rows) !== JSON.stringify([{ event_id: 'upgrade_event', producer_adapter: 'claude', session_id: 'upgrade_session', run_id: 'upgrade_run', event_type: 'upgrade_child' }])) {
      throw new Error(`D1 upgrade fixture lost seeded rows: ${JSON.stringify(rows)}`);
    }
    const foreignKeys = db.query('PRAGMA foreign_key_check').all();
    if (foreignKeys.length !== 0) throw new Error(`D1 upgrade fixture has FK violations: ${JSON.stringify(foreignKeys)}`);
    for (const [table, rows] of Object.entries(expectedRows)) {
      const actualRows = tableRows(db, [table])[table];
      if (actualRows !== rows) throw new Error(`D1 upgrade fixture rows differ in ${table}: ${JSON.stringify({ actual: actualRows, expected: rows })}`);
    }
    // D1 refuses integrity_check; the closed local D1 file permits the full SQLite check.
    const integrity = db.query('PRAGMA integrity_check').all();
    if (JSON.stringify(integrity) !== JSON.stringify([{ integrity_check: 'ok' }])) throw new Error(`D1 upgrade fixture failed integrity_check: ${JSON.stringify(integrity)}`);
  } finally { db.close(); }
}

async function probeForeignKeyAssertion(databaseFile: string, query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<void> {
  const db = new Database(databaseFile);
  try {
    db.exec(`PRAGMA foreign_keys = OFF; INSERT INTO agent_run_events (project_id, run_id, event_type, recorded_at) VALUES ('proj_parity', 'missing_upgrade_run', 'orphan', 1)`);
  } finally { db.close(); }
  try {
    if ((await query('PRAGMA foreign_key_check')).length === 0) throw new Error('FK orphan mutation escaped workerd foreign_key_check');
  } finally {
    const cleanup = new Database(databaseFile);
    try { cleanup.exec("DELETE FROM agent_run_events WHERE run_id = 'missing_upgrade_run'"); }
    finally { cleanup.close(); }
  }
}

function localD1File(persistDir: string): string {
  const dir = path.join(persistDir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`Cloudflare parity target has ${files.length} local D1 database files`);
  return path.join(dir, files[0]!);
}

function touchedTables(statements: readonly string[]): string[] {
  const tables = new Set<string>();
  const patterns = [
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\w+\s+ON\s+(\w+)/i,
    /\b(?:ALTER\s+TABLE|UPDATE|DELETE\s+FROM|INSERT(?:\s+OR\s+\w+)?\s+INTO|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(\w+)/i,
  ];
  for (const statement of statements) for (const pattern of patterns) {
    const table = pattern.exec(statement)?.[1];
    if (table !== undefined && table !== 'schema_meta') tables.add(table);
  }
  return [...tables];
}

function seedPreviousSchema(databaseFile: string, statements: readonly string[]): string[] {
  const db = new Database(databaseFile);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_parity', 'upgrade project', 1);
      INSERT INTO sessions (project_id, session_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_parity', 'upgrade_session', 'upgrade_token', 1, 1);
      INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, producer_adapter) VALUES ('proj_parity', 'upgrade_event', 'upgrade_session', 'upgrade_token', 'prompt', 'import', '{}', 'upgrade_hash', 1, 1, 'claude');
      INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('upgrade_agent', 'upgrade', 'built-in', 1, 1);
      INSERT INTO agent_runs (project_id, id, agent_id, status, started_at) VALUES ('proj_parity', 'upgrade_run', 'upgrade_agent', 'completed', 1);
      INSERT INTO agent_run_events (project_id, run_id, event_type, recorded_at) VALUES ('proj_parity', 'upgrade_run', 'upgrade_child', 1);`);
    const seedTable = (table: string, visiting: Set<string>): void => {
      if (!/^[A-Za-z_]\w*$/.test(table)) throw new Error(`unsupported D1 upgrade fixture table ${table}`);
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return;
      if ((db.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count > 0) return;
      if (visiting.has(table)) throw new Error(`unsupported D1 upgrade fixture FK cycle at ${table}`);
      visiting.add(table);
      const columns = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
      const fks = db.query(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string; to: string }>;
      const values = new Map<string, string | number>();
      for (const fk of fks) {
        seedTable(fk.table, visiting);
        const parent = db.query(`SELECT * FROM "${fk.table}" LIMIT 1`).get() as Record<string, string | number> | null;
        if (parent === null) throw new Error(`unsupported D1 upgrade fixture missing FK parent ${fk.table}`);
        const parentKey = fk.to || (db.query(`PRAGMA table_info("${fk.table}")`).all() as Array<{ name: string; pk: number }>).find((column) => column.pk > 0)?.name;
        if (parentKey === undefined || parent[parentKey] === undefined) throw new Error(`unsupported D1 upgrade fixture FK ${table}.${fk.from}`);
        values.set(fk.from, parent[parentKey]);
      }
      for (const column of columns.filter((item) => (item.notnull || item.pk) && item.dflt_value === null)) {
        if (values.has(column.name) || (column.pk && /INT/i.test(column.type))) continue;
        const name = column.name;
        const value = name === 'project_id' ? PROJECT_ID : name === 'agent_id' ? 'upgrade_agent'
          : name === 'session_id' ? 'upgrade_session' : name === 'run_id' ? 'upgrade_run'
            : name === 'status' ? 'completed' : name === 'role' ? 'member'
              : name === 'state' ? 'draft' : name === 'confidence' ? 'high'
                : name === 'source' ? 'built-in' : /(?:hash|digest)$/.test(name) ? 'a'.repeat(64)
                  : /INT|REAL|NUMERIC/i.test(column.type) ? 1 : `upgrade_${table}`;
        values.set(name, value);
      }
      const names = [...values.keys()];
      try {
        db.query(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...[...values.values()]);
      } catch (error) { throw new Error(`unsupported D1 upgrade fixture cannot seed ${table}: ${String(error)}`); }
      visiting.delete(table);
    };
    const touched = touchedTables(statements).filter((table) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)));
    for (const table of touched) seedTable(table, new Set());
    const candidateChildren = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`).all() as Array<{ name: string }>;
    const visited = new Set<string>();
    const queue = [...touched];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      for (const { name } of candidateChildren) {
        const parents = db.query(`PRAGMA foreign_key_list("${name}")`).all() as Array<{ table: string }>;
        if (!parents.some((fk) => fk.table === parent)) continue;
        seedTable(name, new Set());
        queue.push(name);
      }
    }
    return [...visited];
  } finally { db.close(); }
}

/** The shipped Worker under wrangler dev: real workerd, real migrations, local D1/R2, a throwaway state dir. */
export async function bootCloudflare(options: CloudflareBootOptions = {}): Promise<ParityTarget> {
  const tag = Math.random().toString(36).slice(2, 8);
  const storeId = `parity-store-${tag}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-cloudflare-'));
  const configPath = path.join(root, 'wrangler.toml');
  const configName = configPath;
  const persistDir = path.join(root, 'state');
  const entryPath = path.join(root, 'entry.ts');
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  const main = path.resolve(SERVER_DIR, options.main ?? 'src/index.ts');
  const observer = path.resolve(import.meta.dir, '..', 'observed-worker.ts');
  const telemetry = path.join(root, 'telemetry.ts');
  const originalTelemetry = path.join(SERVER_DIR, 'src', 'telemetry.ts');
  fs.writeFileSync(telemetry, `import { classify as original } from ${JSON.stringify(originalTelemetry)};\nimport { observeHandledException } from ${JSON.stringify(observer)};\nexport * from ${JSON.stringify(originalTelemetry)};\nexport function classify(...args: Parameters<typeof original>) { observeHandledException(args[0]); return original(...args); }\n`);
  fs.writeFileSync(entryPath, `import worker from ${JSON.stringify(main)};\nimport { observedWorker } from ${JSON.stringify(observer)};\nexport * from ${JSON.stringify(main)};\nexport default observedWorker(worker);\n`);
  const derived = parityWranglerConfig();
  // Request diagnostics require asynchronous context propagation.
  const observed = /^compatibility_flags = /m.test(derived)
    ? derived.replace(/^(compatibility_flags = \[)(.*)(\])$/m, '$1$2, "nodejs_als"$3')
    : `compatibility_flags = ["nodejs_als"]\n${derived}`;
  const config = entryConfig(observed, entryPath).replace(/^migrations_dir = .*$/m, `migrations_dir = ${JSON.stringify(path.join(SERVER_DIR, 'migrations'))}`);
  const aliases = PARITY_TELEMETRY_ALIASES
    .map(key => `${JSON.stringify(key)} = ${JSON.stringify(telemetry)}`).join('\n');
  const configTail = `\n[alias]\n${aliases}\n[[secrets_store_secrets]]\nbinding = "SECRET_WRAP_KEY"\nstore_id = "${storeId}"\nsecret_name = "parity-wrap-key"\n`;
  fs.writeFileSync(configPath, config + configTail);

  let completedSqlCommands = 0;
  let lastSqlProgress = performance.now();
  const d1 = async (command: string): Promise<string> => {
    if (started) {
      const reply = await runtime.command({ op: 'sql', tag, sql: command });
      if (!reply.results) throw new Error('local D1 returned no SQL results');
      return JSON.stringify(reply.results);
    }
    const args = ['d1', 'execute', 'myco-server', '--local', '-c', configName, '--persist-to', persistDir, '--json', '--command', command];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await wrangler(args);
        completedSqlCommands += 1;
        const now = performance.now();
        if (now - lastSqlProgress >= SQL_PROGRESS_INTERVAL_MS) {
          console.info(`cloudflare parity: ${completedSqlCommands} D1 commands completed`);
          lastSqlProgress = now;
        }
        return result;
      } catch (error) {
        const wait = lockedRetryWaitMs((error as Error).message, attempt);
        if (wait === null) throw error;
        await Bun.sleep(wait);
      }
    }
  };
  const workerdSql = async (command: string): Promise<Record<string, unknown>[]> => {
    const output = JSON.parse(await d1(command)) as Array<{ results: Record<string, unknown>[] }>;
    if (!Array.isArray(output) || output.length !== 1 || !Array.isArray(output[0]?.results)) {
      throw new Error(`workerd D1 returned no SQL results for ${command}`);
    }
    return output[0].results;
  };

  const cleanup = () => {
    fs.rmSync(root, { recursive: true, force: true });
  };

  let started = false;
  const runtime = session ??= devSession(SERVER_DIR);
  try {
    await wrangler(['secrets-store', 'secret', 'create', storeId, '--name', 'parity-wrap-key', '--scopes', 'workers', '--value', btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), '-c', configName, '--persist-to', persistDir]);
    let upgrade: { version: number; expected: ReturnType<typeof schemaObjects>; expectedRows: Record<string, string>; mutatedConfig: string; mutatedPersist: string } | undefined;
    if (options.latestSchemaUpgrade) {
      const files = renderMigrationFiles();
      const latest = files.at(-1);
      const latestVersion = latest === undefined ? NaN : Number(/^\d+_v(\d+)\.sql$/.exec(latest.name)?.[1]);
      const preceding = files.at(-2);
      const step = SCHEMA_STEPS.at(-1);
      if (latest === undefined || preceding === undefined || step === undefined || latestVersion !== step.version
        || Number(/^\d+_v(\d+)\.sql$/.exec(preceding.name)?.[1]) !== latestVersion - 1
        || step.statements.length < 2) throw new Error(`unsupported D1 upgrade fixture: expected contiguous previous and latest migration with a removable statement; latest is ${latest?.name ?? 'missing'}`);
      const previousDir = path.join(root, 'previous-migrations');
      fs.mkdirSync(previousDir);
      for (const file of files.slice(0, -1)) fs.writeFileSync(path.join(previousDir, file.name), file.sql);
      fs.writeFileSync(configPath, config.replace(/^migrations_dir = .*$/m, `migrations_dir = ${JSON.stringify(previousDir)}`) + configTail);
      await wrangler(['d1', 'migrations', 'apply', 'myco-server', '--local', '-c', configName, '--persist-to', persistDir]);
      const previousFile = localD1File(persistDir);
      const touched = seedPreviousSchema(previousFile, step.statements);
      const previous = new Database(previousFile);
      const previousRows = tableRows(previous, touched);
      previous.close();
      assertUpgradeState(previousFile, latestVersion - 1, expectedSchema(files.slice(0, -1)), previousRows);
      const expectedFile = path.join(root, 'expected-upgrade.sqlite');
      fs.copyFileSync(previousFile, expectedFile);
      const expectedDb = new Database(expectedFile);
      let expectedRows: Record<string, string>;
      try {
        for (const statement of step.statements) expectedDb.exec(statement);
        expectedRows = tableRows(expectedDb, touched);
      } finally { expectedDb.close(); }
      const mutatedPersist = path.join(root, 'mutated-state');
      fs.cpSync(persistDir, mutatedPersist, { recursive: true });
      const mutatedDir = path.join(root, 'mutated-migrations');
      fs.mkdirSync(mutatedDir);
      for (const file of files.slice(0, -1)) fs.writeFileSync(path.join(mutatedDir, file.name), file.sql);
      fs.writeFileSync(path.join(mutatedDir, latest.name), renderMigrationFile({ ...step, statements: step.statements.slice(1) }));
      const mutatedConfig = path.join(root, 'mutated-wrangler.toml');
      fs.writeFileSync(mutatedConfig, config.replace(/^migrations_dir = .*$/m, `migrations_dir = ${JSON.stringify(mutatedDir)}`) + configTail);
      upgrade = { version: latestVersion, expected: expectedSchema(files), expectedRows, mutatedConfig, mutatedPersist };
      fs.writeFileSync(configPath, config + configTail);
    }
    await wrangler(['d1', 'migrations', 'apply', 'myco-server', '--local', '-c', configName, '--persist-to', persistDir]);
    const databaseFile = localD1File(persistDir);
    if (upgrade !== undefined) {
      assertUpgradeState(databaseFile, upgrade.version, upgrade.expected, upgrade.expectedRows);
      if ((await workerdSql('PRAGMA foreign_key_check')).length !== 0) throw new Error('upgraded workerd D1 has FK violations');
      const quickCheck = await workerdSql('PRAGMA quick_check');
      if (JSON.stringify(quickCheck) !== JSON.stringify([{ quick_check: 'ok' }])) throw new Error(`upgraded workerd D1 failed quick_check: ${JSON.stringify(quickCheck)}`);
      await probeForeignKeyAssertion(databaseFile, workerdSql);
      assertUpgradeState(databaseFile, upgrade.version, upgrade.expected, upgrade.expectedRows);
      await wrangler(['d1', 'migrations', 'apply', 'myco-server', '--local', '-c', upgrade.mutatedConfig, '--persist-to', upgrade.mutatedPersist]);
      let detectedDroppedStatement = false;
      try {
        assertUpgradeState(localD1File(upgrade.mutatedPersist), upgrade.version, upgrade.expected, upgrade.expectedRows);
      } catch (error) {
        if (!(error as Error).message.includes('schema objects differ') && !(error as Error).message.includes('rows differ')) throw error;
        detectedDroppedStatement = true;
      }
      if (!detectedDroppedStatement) throw new Error('dropped latest migration statement escaped the D1 upgrade gate');
    }

    const mint = Bun.spawn(['bun', path.join(SERVER_DIR, 'scripts', 'mint-local.ts'), MEMBER_ID, MACHINE_ID, '--rotating', '--print-token'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    SPAWNED.add(mint);
    const [mintCode, mintSql, mintEnv] = await Promise.all([mint.exited, new Response(mint.stdout).text(), new Response(mint.stderr).text()]);
    SPAWNED.delete(mint);
    if (mintCode !== 0) throw new Error(`mint-local exited ${mintCode}: ${mintEnv}`);
    const token = /MYCO_MEMBER_TOKEN=(\S+)/.exec(mintEnv)?.[1];
    if (token === undefined) throw new Error('mint-local printed no token');
    await d1(mintSql.split('\n').filter((l) => !l.startsWith('--')).join(' '));
    await d1(`UPDATE members SET github_id='${GITHUB_SUB}' WHERE id='${MEMBER_ID}'`);
    // The Project every scenario works in exists from boot, as capture would have created it, so no scenario depends on
    // another having captured into it first.
    await d1(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('${PROJECT_ID}', '${PROJECT_ID}', ${Date.now()})`);
    const deploymentRows = JSON.parse(await d1("SELECT value FROM schema_meta WHERE key = 'deployment_id'")) as Array<{ results: Array<{ value: string }> }>;
    const deploymentId = deploymentRows[0]?.results[0]?.value;
    if (!deploymentId) throw new Error('Cloudflare parity target has no Deployment identity');

    const reply = await runtime.command({ op: 'start', tag, config: configPath, persist: persistDir, vars: {
      SESSION_SECRET, GITHUB_CLIENT_ID: 'parity-client', GITHUB_CLIENT_SECRET: 'parity-secret',
      HARNESS_LAUNCH_MODE: 'record', CLOCK_MODE: 'manual',
    } });
    started = true;
    if (!reply.url) throw new Error('Wrangler dev provided no local HTTP listener');
    const url = reply.url;
    const health = await fetch(url + '/health', { headers: reply.headers, signal: AbortSignal.timeout(10_000), keepalive: false });
    const healthBody = await health.text();
    if (!health.ok) throw new Error('Wrangler UserWorker health answered ' + health.status + ': ' + healthBody + '\n' + runtime.runtime().tail);

    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: deploymentId, sub: GITHUB_SUB, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
    return {
      name: 'cloudflare',
      url,
      transportHeaders: reply.headers,
      deploymentId,
      bindings: { database: databaseFile, blob: path.join(persistDir, 'v3', 'r2'), secret: path.join(persistDir, 'v3', 'secrets-store', storeId), vector: null },
      memberToken: token,
      projectId: PROJECT_ID,
      ownerHeaders: () => ({ cookie, 'cf-connecting-ip': '1.2.3.4' }),
      memberHeaders: (extra = {}) => memberHeadersFor(token, PROJECT_ID, extra),
      grantHeaders: (key) => ({ ...grantHeadersFor(key), 'cf-connecting-ip': '1.2.3.4' }),
      sql: async (command) => {
        const out = await d1(command);
        const parsed = JSON.parse(out) as Array<{ results: Record<string, unknown>[] }>;
        return parsed[0]?.results ?? [];
      },
      clockWake: async () => {
        // The cron floor's scheduled handler wakes the clock object, which runs its tick as the clock.
        const res = await fetch(`${url}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
        if (!res.ok) throw new Error(`the scheduled wake answered ${res.status}`);
        await res.body?.cancel();
      },
      runtime: runtime.runtime,
      healthy: async () => {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`cloudflare parity health answered ${response.status}`);
      },
      requestFailure: async (failure) => {
        // Runtime console output can arrive after the HTTP response.
        await Bun.sleep(100);
        const diagnostic = { scenarioRequest: failure, runtime: runtime.runtime(), output: runtime.runtime().tail };
        fs.appendFileSync(path.join(SERVER_DIR, '.wrangler', `parity-dev-${tag}-requests.log`), JSON.stringify(diagnostic) + '\n');
        console.error(`cloudflare parity request failed: ${JSON.stringify(failure)}\nwrangler output:\n${diagnostic.output}`);
      },
      stop: async () => {
        try { await runtime.command({ op: 'stop', tag }); }
        finally { cleanup(); }
      },
    };
  } catch (error) {
    try { await runtime.command({ op: 'stop', tag }); }
    catch (stopError) { console.error('cloudflare parity cleanup failed: ' + String(stopError)); }
    if (!started) console.error('cloudflare parity startup failed:\n' + runtime.runtime().tail);
    cleanup();
    throw error;
  }
}

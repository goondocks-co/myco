import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Database } from 'bun:sqlite';
import { renderMigrationFile, renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { devSession } from './dev-session.ts';
import { assertMigrationMutationDetected, assertUpgradeState, expectedSchema, firstObservableOmission, localD1File, probeForeignKeyAssertion, schemaObjects, seedPreviousSchema, tableRows } from '../schema-upgrade.ts';
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
    let upgrade: { version: number; expected: ReturnType<typeof schemaObjects>; expectedRows: Record<string, string>; previousPersist: string; priorFiles: ReturnType<typeof renderMigrationFiles>; latestName: string; step: (typeof SCHEMA_STEPS)[number] } | undefined;
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
      const previousPersist = path.join(root, 'previous-state');
      fs.cpSync(persistDir, previousPersist, { recursive: true });
      upgrade = { version: latestVersion, expected: expectedSchema(files), expectedRows, previousPersist, priorFiles: files.slice(0, -1), latestName: latest.name, step };
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
      // The last statement stamps the version; omission probes cover the step's data and schema work.
      await firstObservableOmission(upgrade.step.statements.slice(0, -1), async (omittedStatement, index) => {
        const candidateRoot = path.join(root, `mutated-${index}`);
        const mutatedPersist = path.join(candidateRoot, 'state');
        const mutatedDir = path.join(candidateRoot, 'migrations');
        fs.mkdirSync(mutatedDir, { recursive: true });
        fs.cpSync(upgrade.previousPersist, mutatedPersist, { recursive: true });
        for (const file of upgrade.priorFiles) fs.writeFileSync(path.join(mutatedDir, file.name), file.sql);
        fs.writeFileSync(path.join(mutatedDir, upgrade.latestName), renderMigrationFile({ ...upgrade.step, statements: upgrade.step.statements.filter((_, statementIndex) => statementIndex !== index) }));
        const mutatedConfig = path.join(candidateRoot, 'wrangler.toml');
        fs.writeFileSync(mutatedConfig, config.replace(/^migrations_dir = .*$/m, `migrations_dir = ${JSON.stringify(mutatedDir)}`) + configTail);
        await assertMigrationMutationDetected(
          omittedStatement,
          async () => { await wrangler(['d1', 'migrations', 'apply', 'myco-server', '--local', '-c', mutatedConfig, '--persist-to', mutatedPersist]); },
          () => assertUpgradeState(localD1File(mutatedPersist), upgrade.version, upgrade.expected, upgrade.expectedRows),
        );
      });
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

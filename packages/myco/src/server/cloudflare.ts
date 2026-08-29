/**
 * Cloudflare Deployment lifecycle, as operator code.
 *
 * The self-hosted target's counterpart is `deployment.ts`, and both run through
 * the same {@link CommandRunner} so a lifecycle is tested by the argv it
 * produces rather than by provisioning real infrastructure.
 *
 * Cloudflare management credentials are never handed to the deployed
 * application: everything here runs `wrangler` on the operator's machine
 * against the operator's own login. The Worker holds bindings, not an API
 * token that could re-provision the account it runs in.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { runOrThrow, systemRunner, type CommandRunner } from './runner.js';

/** Wrangler refuses to guess between accounts, and guessing is what must not happen. */
export class AccountNotSelected extends Error {
  constructor(readonly available: { name: string; id: string }[]) {
    super(
      'This Cloudflare login can reach more than one account, and none was named. '
      + `Pass --account-id. Available: ${available.map((a) => `${a.name} (${a.id})`).join(', ')}`,
    );
    this.name = 'AccountNotSelected';
  }
}

export interface CloudflareOptions {
  /**
   * The account every command is pinned to.
   *
   * Required rather than defaulted. A login reaching several accounts and a
   * command that picks one silently is how resources land in the wrong place —
   * and a partially provisioned Deployment is worse than a refused one, because
   * some resources exist and the operator does not know which.
   */
  accountId: string;
  runner?: CommandRunner;
  /** Directory holding `wrangler.toml`; the deployment's source of truth. */
  configDir: string;
}

function resolved(options: CloudflareOptions): { runner: CommandRunner; env: NodeJS.ProcessEnv } {
  if (!options.accountId) throw new AccountNotSelected([]);
  return {
    runner: options.runner ?? systemRunner(),
    // Pinned per invocation rather than exported once: a command that outlives
    // this process must not inherit an account selection it never asked for.
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: options.accountId },
  };
}

/** Every wrangler invocation carries the account explicitly. */
function wrangler(...args: string[]): string[] {
  return ['wrangler', ...args];
}

export interface AccountRef { name: string; id: string }

/** Accounts this login can reach, for a caller that has to choose one. */
export async function listAccounts(runner: CommandRunner = systemRunner()): Promise<AccountRef[]> {
  const result = await runner.run('npx', wrangler('whoami'), {});
  const rows: AccountRef[] = [];
  for (const line of result.stdout.split('\n')) {
    // `whoami` prints a table; the id is the 32-hex cell.
    const match = /│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/.exec(line);
    if (match) rows.push({ name: match[1]!.trim(), id: match[2]! });
  }
  return rows;
}

export interface DeployResult { versionId: string | null; url: string | null }

/**
 * Deploy the Worker.
 *
 * `--dry-run` first is not a courtesy: a deploy that fails halfway leaves the
 * account holding some of what it was going to create, and the build is where
 * most failures are.
 */
export async function deployWorker(options: CloudflareOptions & { dryRun?: boolean }): Promise<DeployResult> {
  const { runner, env } = resolved(options);
  const args = wrangler('deploy', ...(options.dryRun === true ? ['--dry-run'] : []));
  const result = await runOrThrow(runner, 'npx', args, { cwd: options.configDir, env });

  return {
    versionId: /Current Version ID:\s*([0-9a-f-]+)/.exec(result.stdout)?.[1] ?? null,
    url: /(https:\/\/[^\s]+\.workers\.dev)/.exec(result.stdout)?.[1] ?? null,
  };
}

/** Apply pending D1 migrations against the deployed database. */
export async function applyMigrations(options: CloudflareOptions & { databaseName: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx',
    wrangler('d1', 'migrations', 'apply', options.databaseName, '--remote'),
    { cwd: options.configDir, env });
}

export interface CloudflareStatus {
  deployed: boolean;
  versionId: string | null;
  raw: string;
}

export async function cloudflareStatus(options: CloudflareOptions & { workerName: string }): Promise<CloudflareStatus> {
  const { runner, env } = resolved(options);
  const result = await runner.run('npx',
    wrangler('deployments', 'list', '--name', options.workerName),
    { cwd: options.configDir, env });

  return {
    deployed: result.code === 0 && result.stdout.trim() !== '',
    versionId: /Version ID:\s*([0-9a-f-]+)/.exec(result.stdout)?.[1] ?? null,
    raw: result.stdout,
  };
}

/**
 * Export the relational store.
 *
 * This is HALF a Deployment backup and says so. `wrangler d1 export` produces a
 * complete SQL dump; wrangler has no bulk export for R2, so blobs are not
 * covered here and no command in this function pretends to cover them.
 *
 * A Deployment restored from this alone has every row and no attachment, which
 * is a worse outcome than a refused backup, so {@link backupCloudflare} returns
 * what it did and did not capture rather than reporting success.
 */
export async function exportDatabase(
  options: CloudflareOptions & { databaseName: string; destination: string },
): Promise<{ sqlPath: string }> {
  const { runner, env } = resolved(options);
  mkdirSync(options.destination, { recursive: true, mode: 0o700 });

  const sqlPath = path.join(options.destination, 'd1.sql');
  await runOrThrow(runner, 'npx',
    wrangler('d1', 'export', options.databaseName, '--remote', '--output', sqlPath),
    { cwd: options.configDir, env });

  return { sqlPath };
}

export interface BackupCoverage {
  destination: string;
  captured: readonly string[];
  /** What a restore from this backup would NOT bring back. */
  notCaptured: readonly string[];
}

/**
 * Back up what can be backed up today, and name what cannot.
 *
 * Blob coverage needs an object-by-object copy over the S3-compatible API or an
 * external tool; #923 owns Deployment backup and restore and is where that
 * belongs. Reporting partial coverage as success is the failure this shape
 * exists to prevent.
 */
export async function backupCloudflare(
  options: CloudflareOptions & { databaseName: string; destination: string },
): Promise<BackupCoverage> {
  await exportDatabase(options);
  return {
    destination: options.destination,
    captured: ['relational store (d1.sql)'],
    notCaptured: ['blob store — wrangler has no bulk R2 export; see #923'],
  };
}

/**
 * Deployment metadata an operator can reproduce, holding no secrets.
 *
 * The account id and resource names are not credentials; the token that reaches
 * them lives in the operator's own wrangler login and never in this file.
 */
export interface DeploymentRecord {
  accountId: string;
  workerName: string;
  databaseName: string;
  bucketName: string;
  versionId: string | null;
  deployedAt: string;
  /** The Deployment's public URL — the custom domain or the workers.dev host — once an operator has named it. */
  url?: string;
}

/** The Worker's sign-in secrets, named as the Worker reads them. */
export interface WorkerSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export interface WorkerSecretTarget {
  accountId: string;
  workerName: string;
  runner?: CommandRunner;
}

/** Raised when wrangler is not installed where `npx` would find it; `npx` would otherwise ask on stdin whether to fetch it, and stdin carries the secrets. */
export class WranglerAbsent extends Error {
  constructor() {
    super('wrangler is not installed; `npm install -g wrangler` (or run from a checkout that has it) and retry');
    this.name = 'WranglerAbsent';
  }
}

/** True when `npx` resolves wrangler without fetching it. */
export async function wranglerPresent(runner: CommandRunner = systemRunner()): Promise<boolean> {
  const result = await runner.run('npx', ['--no-install', 'wrangler', '--version'], {});
  return result.code === 0;
}

/**
 * Install the Worker's sign-in secrets in one request.
 *
 * `wrangler secret bulk` takes the whole set on stdin and sends it as one
 * request, so a Worker never holds a client id whose secret is missing. The
 * account is pinned in the environment and the Worker named on the command
 * line: an operator's machine holds no `wrangler.toml` for a Deployment, and
 * this needs none. Nothing here writes a secret to argv or to a file.
 */
export async function putWorkerSecrets(target: WorkerSecretTarget, secrets: WorkerSecrets): Promise<void> {
  if (!target.accountId) throw new AccountNotSelected([]);
  const runner = target.runner ?? systemRunner();
  if (!(await wranglerPresent(runner))) throw new WranglerAbsent();
  await runOrThrow(runner, 'npx', wrangler('secret', 'bulk', '--name', target.workerName), {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId },
    input: JSON.stringify(secrets),
  });
}

export function deploymentRecordPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, 'server', 'cloudflare.json');
}

export function writeDeploymentRecord(record: DeploymentRecord, mycoHome = resolveMycoHome()): void {
  const file = deploymentRecordPath(mycoHome);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function readDeploymentRecord(mycoHome = resolveMycoHome()): DeploymentRecord | null {
  const file = deploymentRecordPath(mycoHome);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as DeploymentRecord;
}

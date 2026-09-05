/**
 * Self-hosted Deployment lifecycle, as operator code.
 *
 * `myco server ...` is a thin argv layer over this, and `myco setup` calls the
 * same functions, so the two cannot drift into two provisioning behaviours.
 *
 * Every operation runs through a {@link CommandRunner}, which is what lets the
 * lifecycle be tested by the argv it produces rather than by standing up a
 * container per assertion.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveMycoHome } from '../paths/home.js';
import { jsonDocument, runOrThrow, systemRunner, type CommandRunner } from './runner.js';
import { readLiveRunsTwice, systemClock, waitForLiveRuns, type Clock, type LiveRun, type LiveRunRow } from './live-runs.js';
import { COMPOSE_TEMPLATE } from './compose-template.js';
import { ensureServerLayout } from './layout.js';

/** Compose project name; every command is scoped to it so a stack is addressable without a path. */
export const COMPOSE_PROJECT = 'myco';

/**
 * The unprivileged account the image runs as, matching the Dockerfile.
 *
 * Anything written into the volume by a root-privileged path — `docker compose
 * cp` is one — has to be handed back to it, or the server cannot write its own
 * database.
 */
export const RUNTIME_USER = 'myco';

/** Secrets the stack mounts as files, and the byte length each is generated with. */
export const GENERATED_SECRETS = {
  secret_wrap_key: 32,
  session_secret: 32,
  harness_token: 32,
} as const;

/**
 * How long `destroy` gives the stack to stop.
 *
 * The harness holds a long stop grace so a run in flight survives an update.
 * An operator taking the Deployment down is asking for it to stop now, so this
 * verb names its own window rather than inheriting that one.
 */
export const DESTROY_STOP_TIMEOUT_SECONDS = 10;

/** Secrets an operator supplies; created empty so a bind mount never fails on a missing file. */
export const SUPPLIED_SECRETS = ['github_client_secret'] as const;

export interface DeploymentPaths {
  root: string;
  composeFile: string;
  secretsDir: string;
  envFile: string;
}

export function resolveDeploymentPaths(mycoHome = resolveMycoHome()): DeploymentPaths {
  ensureServerLayout(mycoHome);
  const root = path.join(mycoHome, 'server', 'compose');
  return {
    root,
    composeFile: path.join(root, 'compose.yaml'),
    secretsDir: path.join(root, 'secrets'),
    envFile: path.join(root, '.env'),
  };
}

export interface DeploymentOptions {
  paths?: DeploymentPaths;
  runner?: CommandRunner;
}

function resolved(options: DeploymentOptions): { paths: DeploymentPaths; runner: CommandRunner } {
  return { paths: options.paths ?? resolveDeploymentPaths(), runner: options.runner ?? systemRunner() };
}

/** `docker compose` scoped to this stack, with the file and project name pinned. */
function composeArgs(paths: DeploymentPaths, ...rest: string[]): string[] {
  return ['compose', '--file', paths.composeFile, '--project-name', COMPOSE_PROJECT, ...rest];
}

/**
 * Write the bundle an operator can also run with plain `docker compose`.
 *
 * Secret files are written 0600 inside a 0700 directory before the stack is
 * ever started: a bind mount of a world-readable key is not something to
 * correct after the fact.
 */
export function materializeBundle(paths: DeploymentPaths, env: Record<string, string> = {}): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.root, 0o700);
  chmodSync(paths.secretsDir, 0o700);

  writeFileSync(paths.composeFile, COMPOSE_TEMPLATE, { mode: 0o600 });

  for (const [name, bytes] of Object.entries(GENERATED_SECRETS)) {
    const file = path.join(paths.secretsDir, name);
    if (existsSync(file)) continue;
    writeFileSync(file, crypto.randomBytes(bytes).toString('base64'), { mode: 0o600 });
  }
  for (const name of SUPPLIED_SECRETS) {
    const file = path.join(paths.secretsDir, name);
    if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  }

  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  writeFileSync(paths.envFile, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
}

export interface CreateOptions extends DeploymentOptions {
  port?: number;
  version?: string;
  /** How many runtimes the Deployment may run at once; the dispatcher queues past it. */
  fleet?: number;
  /** The address members and the Deployment's own scheduled work reach it at; the loopback publish otherwise. */
  origin?: string;
}

/** How many runtimes a Deployment runs at once when its operator names no count. */
export const DEFAULT_FLEET = 4;

/** Provision and start. Idempotent: an existing bundle keeps its secrets. */
export async function createDeployment(options: CreateOptions = {}): Promise<{ root: string; port: number }> {
  const { paths, runner } = resolved(options);
  const port = options.port ?? 8787;
  const fleet = options.fleet ?? DEFAULT_FLEET;
  if (!Number.isInteger(fleet) || fleet < 1) {
    throw new Error(`the fleet is a whole number of runtimes, 1 or more, and is ${JSON.stringify(options.fleet)}`);
  }

  materializeBundle(paths, {
    MYCO_PORT: String(port),
    MYCO_FLEET: String(fleet),
    ...(options.origin !== undefined && options.origin !== '' ? { MYCO_ORIGIN: options.origin } : {}),
    ...(options.version ? { MYCO_VERSION: options.version } : {}),
  });

  await runOrThrow(runner, 'docker', composeArgs(paths, 'up', '--detach', '--wait'), { cwd: paths.root });
  return { root: paths.root, port };
}

export interface DeploymentStatus {
  provisioned: boolean;
  running: boolean;
  services: string[];
  raw: string;
}

export async function deploymentStatus(options: DeploymentOptions = {}): Promise<DeploymentStatus> {
  const { paths, runner } = resolved(options);
  if (!existsSync(paths.composeFile)) {
    return { provisioned: false, running: false, services: [], raw: '' };
  }

  const result = await runner.run('docker', composeArgs(paths, 'ps', '--format', 'json'), { cwd: paths.root });
  const services = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try { return String((JSON.parse(line) as { Service?: unknown }).Service ?? ''); } catch { return ''; }
    })
    .filter((name) => name !== '');

  return { provisioned: true, running: services.length > 0, services, raw: result.stdout };
}

export interface DestroyOptions extends DeploymentOptions {
  /** Remove the data volume. Absent, the stack goes and the Deployment's data stays. */
  removeData?: boolean;
}

/**
 * Stop and remove the stack, at once.
 *
 * The volume is kept unless `removeData` is set. Data preservation is Myco's
 * core contract, and a `destroy` that takes the vault with it by default gives
 * an operator no way to unmake a mistake.
 *
 * This does not wait for the runs in flight, and it does not give the harness
 * its stop grace: a run live at `destroy` is a run cut off.
 */
export async function destroyDeployment(options: DestroyOptions = {}): Promise<void> {
  const { paths, runner } = resolved(options);
  if (!existsSync(paths.composeFile)) return;

  const args = composeArgs(paths, 'down', '--remove-orphans', '--timeout', String(DESTROY_STOP_TIMEOUT_SECONDS));
  if (options.removeData === true) args.push('--volumes');
  await runOrThrow(runner, 'docker', args, { cwd: paths.root });
}

/** Bundle files present on disk, for `status` and for the adopt check. */
export function bundleContents(paths: DeploymentPaths): string[] {
  if (!existsSync(paths.root)) return [];
  return readdirSync(paths.root).sort();
}

/** Read a materialized secret, for surfaces that must display one. */
export function readSecret(paths: DeploymentPaths, name: string): string | null {
  const file = path.join(paths.secretsDir, name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

/** Remove a bundle from disk. The stack must already be down. */
export function removeBundle(paths: DeploymentPaths): void {
  rmSync(paths.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

/** Where a snapshot is written inside the volume before it is copied out. */
const SNAPSHOT_IN_VOLUME = '/data/.backup-snapshot.sqlite';

/**
 * `VACUUM INTO` rather than a file copy.
 *
 * The database runs in WAL mode (`platform/bun/database.ts:19`), so the `.sqlite`
 * file alone is not the database — committed pages live in the `-wal` sidecar
 * until a checkpoint. Copying the one file yields a backup missing every commit
 * since the last checkpoint, and it restores without complaint. `VACUUM INTO`
 * writes a consistent standalone snapshot from the live connection.
 */
const VACUUM_SCRIPT = `const{Database}=require('bun:sqlite');`
  + `const d=new Database(process.env.MYCO_DATABASE);`
  + `d.query("VACUUM INTO ?").run(${JSON.stringify(SNAPSHOT_IN_VOLUME)});d.close();`;

export interface BackupOptions extends DeploymentOptions {
  /** Directory the snapshot and blobs are written into. */
  destination: string;
}

/**
 * Snapshot a running Deployment.
 *
 * Blobs are copied live without ceremony: the store is content-addressed, so an
 * object's bytes never change once written and a copy taken mid-write is either
 * absent or complete.
 */
export async function backupDeployment(options: BackupOptions): Promise<{ destination: string }> {
  const { paths, runner } = resolved(options);
  mkdirSync(options.destination, { recursive: true, mode: 0o700 });

  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'exec', '--no-TTY', 'server', 'bun', '-e', VACUUM_SCRIPT), { cwd: paths.root });
  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'cp', `server:${SNAPSHOT_IN_VOLUME}`, path.join(options.destination, 'myco.sqlite')), { cwd: paths.root });
  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'cp', 'server:/data/blobs', path.join(options.destination, 'blobs')), { cwd: paths.root });
  // The snapshot is a full copy of the database; leaving it doubles the volume.
  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'exec', '--no-TTY', 'server', 'rm', '-f', SNAPSHOT_IN_VOLUME), { cwd: paths.root });

  return { destination: options.destination };
}

export interface RestoreOptions extends DeploymentOptions {
  /** Directory produced by {@link backupDeployment}. */
  source: string;
}

/**
 * Replace a Deployment's data with a backup.
 *
 * The stack is stopped first. Copying a database under a running server would
 * leave its open connection reading pages that no longer describe the file.
 */
export async function restoreDeployment(options: RestoreOptions): Promise<void> {
  const { paths, runner } = resolved(options);
  const snapshot = path.join(options.source, 'myco.sqlite');
  if (!existsSync(snapshot)) {
    throw new Error(`${options.source} holds no myco.sqlite; it is not a Deployment backup`);
  }

  await runOrThrow(runner, 'docker', composeArgs(paths, 'stop'), { cwd: paths.root });
  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'cp', snapshot, 'server:/data/myco.sqlite'), { cwd: paths.root });
  if (existsSync(path.join(options.source, 'blobs'))) {
    await runOrThrow(runner, 'docker',
      composeArgs(paths, 'cp', path.join(options.source, 'blobs'), 'server:/data/blobs'), { cwd: paths.root });
  }
  // Two things the copy leaves wrong, fixed as root before anything starts.
  //
  // `docker compose cp` writes as root, and the image runs unprivileged, so a
  // copied database is read-only to the server — which surfaces as the
  // container crash-looping on "attempt to write a readonly database" rather
  // than as a failed restore.
  //
  // A WAL sidecar left in the volume belongs to the database the snapshot
  // replaces, and SQLite replays it over the snapshot on open.
  await runOrThrow(runner, 'docker',
    composeArgs(paths, 'run', '--rm', '--user', 'root', '--entrypoint', 'sh', 'server', '-c',
      `rm -f /data/myco.sqlite-wal /data/myco.sqlite-shm && chown -R ${RUNTIME_USER}:${RUNTIME_USER} /data`),
    { cwd: paths.root });
  await runOrThrow(runner, 'docker', composeArgs(paths, 'up', '--detach', '--wait'), { cwd: paths.root });
}

/**
 * What carries a run this deploy stopped waiting on. The harness shares the
 * server's network namespace, so a recreate stops it first and every runtime it
 * holds finishes inside its stop grace, posting its own ending.
 */
const COMPOSE_SPARING = 'the harness finishes them inside its stop grace';

/**
 * The runs the Deployment has in flight, read from the running container.
 *
 * The server binary answers its own volume: `exec` runs it beside the serving
 * process, past the entrypoint, so no migration runs and the image's own
 * `MYCO_DATABASE` and unprivileged user apply. The read is asked twice and a
 * second bad answer refuses the deploy — "nothing came back" and "nothing is
 * running" are opposite facts, and a deploy that confused them would recreate
 * straight over live work.
 */
export async function readComposeLiveRuns(
  options: DeploymentOptions & { sleep?: (ms: number) => Promise<void> },
): Promise<LiveRun[]> {
  const { paths, runner } = resolved(options);
  return readLiveRunsTwice({
    ask: async () => (await runOrThrow(runner, 'docker',
      composeArgs(paths, 'exec', '--no-TTY', 'server', 'bun', 'run', '/app/server.js', '--live-runs'),
      { cwd: paths.root })).stdout,
    rowsIn: (output) => jsonDocument<LiveRunRow[]>(output),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

export interface UpdateOptions extends DeploymentOptions {
  version?: string;
  /** Skip returning to the previous version when the new one fails to come up. */
  noRollback?: boolean;
  /** Skip the wait for the runs in flight. They still finish inside the harness's stop grace, and the recreate waits behind them. */
  noDrain?: boolean;
  /** Where the wait says where it is, as it gets there. */
  report?: (line: string) => void;
  clock?: Clock;
}

/** The version a bundle is pinned to, or null when it tracks the default tag. */
export function pinnedVersion(paths: DeploymentPaths): string | null {
  if (!existsSync(paths.envFile)) return null;
  const line = readFileSync(paths.envFile, 'utf8')
    .split('\n').find((l) => l.startsWith('MYCO_VERSION='));
  return line === undefined ? null : line.slice('MYCO_VERSION='.length);
}

/** Set one key in the bundle's `.env`, or drop it when `value` is null; every other line survives. */
function upsertEnv(paths: DeploymentPaths, key: string, value: string | null): void {
  const current = existsSync(paths.envFile) ? readFileSync(paths.envFile, 'utf8') : '';
  const kept = current.split('\n').filter((l) => l !== '' && !l.startsWith(`${key}=`));
  const lines = value === null ? kept : [...kept, `${key}=${value}`];
  writeFileSync(paths.envFile, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
}

/** Rewrite the pin, or drop it when `version` is null. */
function writePin(paths: DeploymentPaths, version: string | null): void {
  upsertEnv(paths, 'MYCO_VERSION', version);
}

/** The sign-in credentials a Deployment holds: the id in `.env` (Compose passes it as an environment value), the secret as a mounted file. */
export interface SignInSecrets {
  clientId: string;
  clientSecret: string;
}

/**
 * Write the sign-in credentials into the bundle. The secret goes into the
 * mounted secret file the compose file already declares, 0600; the id is an
 * `.env` value the compose file passes through. The running container reads
 * neither until it is recreated (`recreateDeployment`).
 */
export function writeSignInSecrets(paths: DeploymentPaths, secrets: SignInSecrets): void {
  mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(paths.secretsDir, 'github_client_secret'), secrets.clientSecret, { mode: 0o600 });
  upsertEnv(paths, 'GITHUB_CLIENT_ID', secrets.clientId);
}

/** Recreate the container so it reads the bundle's current secrets and env; a plain `up` leaves a running container on the bytes it started with. */
export async function recreateDeployment(options: DeploymentOptions = {}): Promise<void> {
  const { paths, runner } = resolved(options);
  await runOrThrow(runner, 'docker', composeArgs(paths, 'up', '--detach', '--force-recreate', '--wait'), { cwd: paths.root });
}

export class UpdateRolledBack extends Error {
  constructor(readonly previous: string | null, readonly cause: Error) {
    super(`update failed and the Deployment was returned to ${previous ?? 'its previous image'}: ${cause.message}`);
    this.name = 'UpdateRolledBack';
  }
}

/**
 * Move a Deployment to a new image.
 *
 * Migration is not performed here. The container entrypoint applies the steps
 * its volume is behind before the listener binds, so recreating the container
 * IS the migration — and the request handler refuses a volume that is behind,
 * which is what makes a half-finished update fail loudly rather than serve.
 */
export async function updateDeployment(options: UpdateOptions = {}): Promise<void> {
  const { paths, runner } = resolved(options);
  const previous = pinnedVersion(paths);

  // Recreating the server stops the harness with it, so the runs in flight are
  // waited out first. --no-drain skips the wait and the read it needs, which is
  // what makes it the escape hatch for a container that cannot be reached.
  if (options.noDrain !== true) {
    const clock = options.clock ?? systemClock;
    await waitForLiveRuns({
      read: () => readComposeLiveRuns({ paths, runner, sleep: (ms) => clock.sleep(ms) }),
      sparing: COMPOSE_SPARING,
      clock,
      ...(options.report === undefined ? {} : { report: options.report }),
    });
  }

  // The requested version travels as an environment override for the pull and
  // the recreate, and is written into the bundle only once both succeed.
  // Writing it first leaves a bundle pinning a version that was never deployed
  // when the pull fails — the file and the running container disagreeing, with
  // nothing to say which is right.
  const env = options.version === undefined
    ? undefined
    : { ...process.env, MYCO_VERSION: options.version };

  try {
    await runOrThrow(runner, 'docker', composeArgs(paths, 'pull'), { cwd: paths.root, env });
    await runOrThrow(runner, 'docker', composeArgs(paths, 'up', '--detach', '--wait'), { cwd: paths.root, env });
  } catch (err) {
    // `up` recreates the container before it waits for health, so a version
    // that starts and fails its healthcheck has already replaced the one that
    // worked. Returning to the previous pin is what makes that recoverable
    // without an operator reconstructing which tag was running.
    if (options.noRollback === true || options.version === undefined) throw err;

    writePin(paths, previous);
    await runner.run('docker', composeArgs(paths, 'up', '--detach', '--wait'), { cwd: paths.root });
    throw new UpdateRolledBack(previous, err as Error);
  }

  if (options.version !== undefined) writePin(paths, options.version);
}

/**
 * Replace the generated secrets and restart.
 *
 * `session_secret` signs owner sessions, so rotating it ends every signed-in
 * session. That is the point of the operation and the reason the CLI requires
 * it to be asked for explicitly.
 */
export async function rotateSecrets(options: DeploymentOptions = {}): Promise<string[]> {
  const { paths, runner } = resolved(options);
  const rotated: string[] = [];
  for (const [name, bytes] of Object.entries(GENERATED_SECRETS)) {
    writeFileSync(path.join(paths.secretsDir, name), crypto.randomBytes(bytes).toString('base64'), { mode: 0o600 });
    rotated.push(name);
  }
  await recreateDeployment({ paths, runner });
  return rotated;
}

/**
 * Write a bundle for a stack this machine did not provision.
 *
 * Secrets and the volume are left untouched: adopting is about regaining the
 * ability to operate a stack, not about reissuing its keys.
 */
export async function adoptDeployment(options: DeploymentOptions = {}): Promise<{ adopted: boolean; services: string[] }> {
  const { paths, runner } = resolved(options);
  materializeBundle(paths);

  const status = await deploymentStatus({ paths, runner });
  return { adopted: status.running, services: status.services };
}

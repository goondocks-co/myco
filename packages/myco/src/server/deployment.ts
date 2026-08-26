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
import { runOrThrow, systemRunner, type CommandRunner } from './runner.js';
import { COMPOSE_TEMPLATE } from './compose-template.js';

/** Compose project name; every command is scoped to it so a stack is addressable without a path. */
export const COMPOSE_PROJECT = 'myco';

/** Secrets the stack mounts as files, and the byte length each is generated with. */
export const GENERATED_SECRETS = {
  secret_wrap_key: 32,
  session_secret: 32,
} as const;

/** Secrets an operator supplies; created empty so a bind mount never fails on a missing file. */
export const SUPPLIED_SECRETS = ['github_client_secret'] as const;

export interface DeploymentPaths {
  root: string;
  composeFile: string;
  secretsDir: string;
  envFile: string;
}

export function resolveDeploymentPaths(mycoHome = resolveMycoHome()): DeploymentPaths {
  const root = path.join(mycoHome, 'server');
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
}

/** Provision and start. Idempotent: an existing bundle keeps its secrets. */
export async function createDeployment(options: CreateOptions = {}): Promise<{ root: string; port: number }> {
  const { paths, runner } = resolved(options);
  const port = options.port ?? 8787;

  materializeBundle(paths, {
    MYCO_PORT: String(port),
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
 * Stop and remove the stack.
 *
 * The volume is kept unless `removeData` is set. Data preservation is Myco's
 * core contract, and a `destroy` that takes the vault with it by default gives
 * an operator no way to unmake a mistake.
 */
export async function destroyDeployment(options: DestroyOptions = {}): Promise<void> {
  const { paths, runner } = resolved(options);
  if (!existsSync(paths.composeFile)) return;

  const args = composeArgs(paths, 'down', '--remove-orphans');
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

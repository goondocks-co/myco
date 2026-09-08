/**
 * The staged deploy directory: everything wrangler reads for one Cloudflare
 * deploy, written from artifacts the binary carries.
 *
 * Provisioning holds no repository checkout, so the Worker bundle, the
 * dashboard and the migration files are produced here rather than built. This
 * module is the single writer of that directory: it is reset on every stage, so
 * no file from a previous version can reach a deploy, and the config is
 * rendered through `renderDeployConfig` so the file wrangler reads and the
 * deployment record can never describe different deployments.
 *
 * Layout is load-bearing. The bundle sits alone under `worker/` because
 * wrangler's `base_dir` defaults to the directory holding the entry point, and
 * an entry beside the dashboard and the migrations would carry both into the
 * Worker script as modules.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { BUNDLED_SERVER_UI } from '../server-ui-assets.generated.js';
import { BUNDLED_WORKER } from '../worker-bundle.generated.js';
import { renderDeployConfig } from './deploy-config.js';
import { deploymentRecordPath, type DeploymentRecord } from './cloudflare.js';

export const DEPLOY_CONFIG_NAME = 'wrangler.deploy.toml';

/** Where the entry point sits inside the staged directory, alone. */
export const WORKER_ENTRY = path.join('worker', 'worker.js');

/** A configuration key's value, read from the config a deploy will actually use. */
function declared(config: string, key: string): string {
  const value = new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(config)?.[1];
  if (value === undefined) throw new Error(`the deploy config declares no ${key}; cloudflare-stage and the configuration have drifted`);
  return value;
}

export interface StagedDeploy {
  /** The directory every wrangler invocation runs in. */
  dir: string;
  /** The rendered config, relative to `dir`, for wrangler's `-c`. */
  configFile: string;
  /** How many migration files were written; one per schema step. */
  migrations: number;
}

/** This target's own subtree on this machine: the binary's, holding no wrangler configuration. */
export function stagingRoot(mycoHome?: string): string {
  return path.dirname(deploymentRecordPath(mycoHome));
}

/** The staging directory for this machine, beside the deployment record. */
export function stagingDir(mycoHome?: string): string {
  return path.join(stagingRoot(mycoHome), 'deploy');
}

function writeFileUnder(root: string, relative: string, bytes: Uint8Array | string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes);
}

/**
 * Write everything one deploy reads, from nothing but the record and the
 * artifacts this binary carries.
 *
 * The directory is removed first rather than written over: a stale asset from a
 * previous version is served exactly as confidently as a current one.
 */
export function stageCloudflareDeploy(record: DeploymentRecord, mycoHome?: string): StagedDeploy {
  // Rendered before the directory is touched: a record that cannot address its
  // own database refuses here, with the previous stage still intact.
  const config = renderDeployConfig(record);

  const dir = stagingDir(mycoHome);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileUnder(dir, WORKER_ENTRY, Buffer.from(BUNDLED_WORKER, 'base64'));

  // Both directories are read out of the config a deploy will use, so the
  // dashboard and the migrations always land where wrangler is told to look.
  const assetsDir = declared(config, 'directory');
  const migrationsDir = declared(config, 'migrations_dir');

  for (const [name, encoded] of Object.entries(BUNDLED_SERVER_UI)) {
    writeFileUnder(dir, path.join(assetsDir, name), Buffer.from(encoded, 'base64'));
  }

  const migrations = renderMigrationFiles();
  for (const file of migrations) writeFileUnder(dir, path.join(migrationsDir, file.name), file.sql);

  writeFileSync(path.join(dir, DEPLOY_CONFIG_NAME), config, { mode: 0o600 });

  return { dir, configFile: DEPLOY_CONFIG_NAME, migrations: migrations.length };
}

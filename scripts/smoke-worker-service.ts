import { defaultSpec, installService, uninstallService, statusOfService, type ServiceSpec } from '../packages/myco/src/server/service.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { readDeploymentMembership } from '../packages/myco/src/member/registry.js';

const RESTART_THROTTLE_SECONDS = 10;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const LABEL_PREFIX = 'co.goondocks.myco-smoke-worker';
const LABEL_HASH_CHARS = 16;

export interface WorkerRigConfig {
  binary: string;
  mycoHome: string;
  root: string;
  server: string;
  harness: string;
  pathEnv: string;
  startAt: 'login' | 'boot';
}

export function workerRigSpec(config: WorkerRigConfig, userHome = homedir()): ServiceSpec {
  const url = new URL(config.server);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'The rig requires an HTTPS Deployment URL without credentials, query or fragment');
  assert(/^[a-z][a-z0-9-]*$/.test(config.harness), 'Name exactly one worker harness');
  for (const value of [config.binary, config.mycoHome, config.root, userHome]) {
    assert(path.isAbsolute(value), 'Worker binary, homes and rig root must be absolute paths');
  }
  assert(config.pathEnv.length > 0, 'PATH must name the installed harness and its runtime');
  assert(config.startAt === 'login' || config.startAt === 'boot', 'Choose login or boot explicitly');
  const identity = createHash('sha256').update(JSON.stringify([config.root, config.mycoHome, url.href])).digest('hex').slice(0, LABEL_HASH_CHARS);
  assert(config.startAt === 'login', 'A registered worker uses a per-user login service');
  return {
    ...defaultSpec(config.binary, userHome, process.platform, config.mycoHome),
    pathEnv: config.pathEnv,
    logDir: config.root,
    env: { HOME: userHome, MYCO_HOME: config.mycoHome, MYCO_TRAMPOLINED: '1' },
    unit: {
      label: `${LABEL_PREFIX}.${identity}`,
      unitName: `${LABEL_PREFIX}.${identity}`,
      description: 'Myco smoke-rig worker',
      args: ['worker', '--server', config.server, '--harness', config.harness],
      logName: 'worker',
      restartDelaySeconds: RESTART_THROTTLE_SECONDS,
    },
  };
}

function assertPersistentPath(value: string): void {
  assert(path.isAbsolute(value), 'Use absolute paths for the rig');
  const resolved = realpathSync(value);
  for (const temporary of ['/tmp', '/var/tmp', tmpdir()]) {
    const relative = path.relative(realpathSync(temporary), resolved);
    assert(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative),
      `The worker must survive temporary-directory cleanup: ${value}`);
  }
}

export async function runWorkerRig(action: string, config: WorkerRigConfig): Promise<void> {
  assert(process.platform === 'darwin', 'This smoke rig currently supports macOS only');
  assert(['plan', 'install', 'status', 'uninstall'].includes(action), 'Use plan, install, status or uninstall');
  const spec = workerRigSpec(config);
  if (action === 'status') {
    console.log(JSON.stringify(statusOfService(spec)));
    return;
  }
  if (action === 'uninstall') {
    console.log(JSON.stringify(uninstallService(spec)));
    return;
  }
  for (const value of [config.binary, config.mycoHome, config.root]) assertPersistentPath(value);
  assert(readDeploymentMembership(config.server, config.mycoHome), 'No membership for the named Deployment in MYCO_HOME');
  const options = { cwd: config.root, env: spec.env, encoding: 'utf8' as const, timeout: PREFLIGHT_TIMEOUT_MS };
  const version = execFileSync(config.binary, ['--version'], options).trim();
  const detection = execFileSync(config.binary, ['worker', '--detect', '--harness', config.harness], options);
  assert(detection.split('\n').some((line) => line.trim().split(/\s+/).join(' ') === `${config.harness} installed logged in`),
    `Harness is not ready in the service environment: ${detection.trim()}`);
  console.log(JSON.stringify({ version, spec }));
  if (action === 'plan') return;
  assert(!statusOfService(spec).installed, 'Rig service already exists; explicitly uninstall before replacing it');
  console.log(JSON.stringify(installService(spec)));
}

export function workerRigConfigFromEnv(env: NodeJS.ProcessEnv): WorkerRigConfig {
  const required = (name: string): string => {
    const value = env[name];
    assert(value !== undefined && value.trim().length > 0, `Set ${name} explicitly`);
    return value;
  };
  const startAt = required('MYCO_SMOKE_START_AT');
  assert(startAt === 'login' || startAt === 'boot', 'MYCO_SMOKE_START_AT must be login or boot');
  return {
    binary: required('MYCO_SMOKE_BINARY'), mycoHome: required('MYCO_HOME'),
    root: required('MYCO_SMOKE_ROOT'), server: required('MYCO_SMOKE_SERVER'),
    harness: required('MYCO_SMOKE_HARNESS'), pathEnv: required('PATH'), startAt,
  };
}

if (import.meta.main) await runWorkerRig(process.argv[2] ?? 'plan', workerRigConfigFromEnv(process.env));

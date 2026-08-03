import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRuntimeIsForeign } from '@myco/daemon/update-checker.js';
import {
  CanopyDeltaScanRunner,
  CanopyJobsRegistry,
  type CanopyRunnerIdentity,
  type CanopyRunnerSharedDeps,
} from '@myco/daemon/jobs/canopy-scan.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

// A project whose `runtime.home` pin routes to a different MYCO_HOME is served
// by ANOTHER daemon (the dogfood split). This daemon must not scan it — a scan
// here builds canopy rows the owning runtime never describes, a permanent
// phantom backlog that misleads the operations view and holds the daemon out
// of deep sleep. Incident: the prod daemon's boot-time initial populate built
// 2,313 undescribed rows for the dev-pinned myco repo (2026-08-03).

const PROJECT = assertGroveProjectId('proj_' + 'a'.repeat(32));

let tmp: string;
let mycoHome: string;
let otherHome: string;
let projectRoot: string;
let savedMycoHomeEnv: string | undefined;

function writePin(value: string): void {
  const vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const pinPath = path.join(vaultDir, 'runtime.home');
  fs.writeFileSync(pinPath, `${value}\n`, { mode: 0o644 });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-foreign-runtime-'));
  mycoHome = path.join(tmp, 'home-a');
  otherHome = path.join(tmp, 'home-b');
  projectRoot = path.join(tmp, 'repo');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(otherHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  // Hermetic MYCO_HOME so the machine-pin fallback never reads the real ~/.myco.
  savedMycoHomeEnv = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
});

afterEach(() => {
  if (savedMycoHomeEnv === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHomeEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('projectRuntimeIsForeign', () => {
  it('is not foreign without a pin (the common case)', () => {
    expect(projectRuntimeIsForeign(path.join(projectRoot, '.myco'), mycoHome)).toBe(false);
  });

  it('is not foreign when the pin matches this daemon\'s home', () => {
    writePin(mycoHome);
    expect(projectRuntimeIsForeign(path.join(projectRoot, '.myco'), mycoHome)).toBe(false);
  });

  it('is foreign when the pin routes to a different home', () => {
    writePin(otherHome);
    expect(projectRuntimeIsForeign(path.join(projectRoot, '.myco'), mycoHome)).toBe(true);
  });
});

describe('canopy scan foreign-runtime gate', () => {
  function makeShared(): { deps: CanopyRunnerSharedDeps; resolveDbCalls: number[] } {
    const resolveDbCalls: number[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as DaemonLogger;
    const deps: CanopyRunnerSharedDeps = {
      logger,
      machineId: 'test-machine',
      liveConfig: {
        current: {
          cortex: { canopy: { exclude: { default_patterns: [], patterns: [] } } },
        } as CanopyRunnerSharedDeps['liveConfig']['current'],
      },
      resolveDb: () => {
        resolveDbCalls.push(1);
        throw new Error('resolveDb must not be reached for a foreign-routed project');
      },
    };
    return { deps, resolveDbCalls };
  }

  function identity(): CanopyRunnerIdentity {
    return {
      databasePath: path.join(tmp, 'unused.db'),
      projectId: PROJECT,
      projectRoot,
      groveId: 'grove_' + 'f'.repeat(32),
    };
  }

  it('skips the delta scan for a foreign-routed project', async () => {
    writePin(otherHome);
    const { deps, resolveDbCalls } = makeShared();
    const runner = new CanopyDeltaScanRunner(identity(), deps);
    await runner.run();
    expect(resolveDbCalls).toHaveLength(0);
  });

  it('skips initial populate and full scan for a foreign-routed project', async () => {
    writePin(otherHome);
    const { deps, resolveDbCalls } = makeShared();
    const registry = new CanopyJobsRegistry(deps);
    await registry.initialPopulate(identity());
    await registry.runFullScan(identity());
    expect(resolveDbCalls).toHaveLength(0);
  });
});

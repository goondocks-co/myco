import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import {
  buildScheduledJobs,
  type ScheduledJobContext,
} from '@myco/daemon/task-scheduler.js';
import type { RegisteredProjectScope } from '@myco/daemon/scope-iteration.js';
import type { AgentTask } from '@myco/agent/types.js';
import { assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  isProjectPaused,
  pauseProject,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';

const PROJECT_A: GroveProjectId = assertGroveProjectId('proj_' + 'a'.repeat(32));
const PROJECT_B: GroveProjectId = assertGroveProjectId('proj_' + 'b'.repeat(32));

function fakeScope(projectId: GroveProjectId, grove: GroveRecord): RegisteredProjectScope {
  return {
    grove,
    groveHome: '',
    databasePath: '',
    db: {} as RegisteredProjectScope['db'],
    project: {
      project_id: projectId,
      name: projectId,
      root: `/tmp/${projectId}`,
      created_at: '',
      updated_at: '',
    },
    projectId,
    projectRoot: `/tmp/${projectId}`,
    projectVaultDir: `/tmp/${projectId}/.myco`,
    requestContext: {} as RegisteredProjectScope['requestContext'],
  };
}

function makeTask(name: string): AgentTask {
  return {
    name,
    displayName: name,
    description: 'test',
    agent: 'myco-agent',
    prompt: 'test',
    isDefault: false,
    schedule: { enabled: true, intervalSeconds: 1, runIn: ['active', 'idle'] },
  };
}

describe('scheduler skips paused projects', () => {
  let home: string;
  let previousHome: string | undefined;
  let grove: GroveRecord;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sched-pause-'));
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    clearGroveRegistryCaches();
    grove = createGrove('Test', home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_A,
      projectName: 'A',
      projectRoot: `/tmp/${PROJECT_A}`,
    }, home);
    registerProjectInGrove(grove.id, {
      projectId: PROJECT_B,
      projectName: 'B',
      projectRoot: `/tmp/${PROJECT_B}`,
    }, home);
  });

  afterEach(() => {
    clearGroveRegistryCaches();
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function makeContext(visited: GroveProjectId[]): ScheduledJobContext {
    const scopes = [fakeScope(PROJECT_A, grove), fakeScope(PROJECT_B, grove)];
    return {
      // Mirror the production filter: same callback as task-scheduling.ts's
      // shouldVisit, so this test exercises the actual integration shape.
      forEachProject: async (visit) => {
        for (const scope of scopes) {
          const paused = isProjectPaused(scope.projectId, home);
          if (paused.paused) continue;
          await visit(scope);
        }
      },
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      runTask: async (scope) => { visited.push(scope.projectId); },
      preConditions: {},
      getProjectPowerState: () => 'idle',
      getTaskConfig: () => undefined,
    };
  }

  it('skips a paused project on the next tick', async () => {
    pauseProject(grove.id, PROJECT_A, 'grove-move', 'op-1', null, home);

    const visited: GroveProjectId[] = [];
    const { jobs } = buildScheduledJobs([makeTask('vault-evolve')], makeContext(visited));
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(visited).toEqual([PROJECT_B]);
  });

  it('runs scheduled tasks for unpaused projects', async () => {
    const visited: GroveProjectId[] = [];
    const { jobs } = buildScheduledJobs([makeTask('vault-evolve')], makeContext(visited));
    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));

    expect(new Set(visited)).toEqual(new Set([PROJECT_A, PROJECT_B]));
  });
});

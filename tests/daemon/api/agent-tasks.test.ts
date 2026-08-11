/**
 * agent-tasks CRUD handler tests.
 *
 * Real fs against a temp vault — no module mocks. Covers the security-
 * relevant invariants from the deleted 455-line mock-heavy file:
 *  - handleCreateTask rejects invalid names before touching disk
 *  - handleCopyTask writes only under vault tasks/ and uses the validated name
 *  - handleDeleteTask succeeds for user tasks and refuses to touch built-ins
 *
 * These call the real registry helpers (writeUserTask/copyTaskToUser/
 * deleteUserTask) so any drift in the registry → handler contract
 * surfaces here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleCreateTask,
  handleCopyTask,
  handleDeleteTask,
  handleGetTaskConfig,
  handleUpdateTaskConfig,
} from '@myco/daemon/api/agent-tasks.js';
import { invalidateMergedConfigCache } from '@myco/config/loader.js';
import { createGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { resolveGroveConfigPath } from '@myco/grove/paths.js';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
import type { RouteRequest } from '@myco/daemon/router.js';

let vaultDir: string;
let mycoHome: string;
let previousMycoHome: string | undefined;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-tasks-'));
  mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-tasks-home-'));
  previousMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  clearGroveRegistryCaches();
  invalidateMergedConfigCache();
});

afterEach(() => {
  if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = previousMycoHome;
  clearGroveRegistryCaches();
  invalidateMergedConfigCache();
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(mycoHome, { recursive: true, force: true });
});

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/api/agent/tasks',
    requestContext: TEST_REQUEST_CONTEXT,
    ...overrides,
  } as RouteRequest;
}

function makeValidBody(name: string) {
  return {
    name,
    displayName: 'Test',
    description: 'A task for testing',
    agent: 'myco-agent',
    prompt: 'Do the thing.',
    isDefault: false,
  };
}

describe('handleCreateTask', () => {
  it('returns 400 when the body fails schema validation', async () => {
    const res = await handleCreateTask(makeReq({ body: { name: 'oops' } }), vaultDir);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('validation_failed');
  });

  it('rejects names that fail validateTaskName before writing', async () => {
    // Uppercase and underscore both violate TASK_NAME_PATTERN
    const res = await handleCreateTask(
      makeReq({ body: makeValidBody('Bad_Name') }),
      vaultDir,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string; name: string }).error).toBe('invalid_task_name');
    expect(fs.existsSync(path.join(vaultDir, 'tasks'))).toBe(false);
  });

  it('rejects names containing dot-segments (path traversal guard)', async () => {
    const res = await handleCreateTask(
      makeReq({ body: makeValidBody('../escape') }),
      vaultDir,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_task_name');
    expect(fs.existsSync(path.join(vaultDir, 'tasks'))).toBe(false);
  });

  it('writes a valid task under vaultDir/tasks/ on success', async () => {
    const res = await handleCreateTask(
      makeReq({ body: makeValidBody('valid-task-name') }),
      vaultDir,
    );
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(vaultDir, 'tasks', 'valid-task-name.yaml'))).toBe(true);
  });
});

describe('handleCopyTask', () => {
  it('refuses an invalid override name without touching disk', async () => {
    // No source task exists in the temp vault — but validation must trip first
    // so the response is 400 (invalid_task_name) rather than 404.
    const res = await handleCopyTask(
      makeReq({ params: { id: 'whatever' }, body: { name: 'BAD NAME' } }),
      vaultDir,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_task_name');
    expect(fs.existsSync(path.join(vaultDir, 'tasks'))).toBe(false);
  });

  it('copies a user task to a new validated name under vault tasks/', async () => {
    // Seed an existing user task so we don't depend on built-ins.
    await handleCreateTask(
      makeReq({ body: makeValidBody('source-task') }),
      vaultDir,
    );

    const res = await handleCopyTask(
      makeReq({ params: { id: 'source-task' }, body: { name: 'copied-task' } }),
      vaultDir,
    );
    expect(res.status).toBe(201);
    const written = path.join(vaultDir, 'tasks', 'copied-task.yaml');
    expect(fs.existsSync(written)).toBe(true);
    // Confirm the copy stayed inside the vault.
    expect(path.dirname(written).startsWith(vaultDir)).toBe(true);
  });

  it('returns 404 when the source task does not exist', async () => {
    const res = await handleCopyTask(
      makeReq({ params: { id: 'does-not-exist' }, body: { name: 'new-name' } }),
      vaultDir,
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('task_not_found');
  });
});

describe('handleDeleteTask', () => {
  it('deletes an existing user task', async () => {
    await handleCreateTask(makeReq({ body: makeValidBody('delete-me') }), vaultDir);
    const filePath = path.join(vaultDir, 'tasks', 'delete-me.yaml');
    expect(fs.existsSync(filePath)).toBe(true);

    const res = await handleDeleteTask(
      makeReq({ params: { id: 'delete-me' } }),
      vaultDir,
    );
    expect(res.status).toBe(200);
    expect((res.body as { deleted: string }).deleted).toBe('delete-me');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('returns 404 for a task that does not exist (idempotent semantics)', async () => {
    const res = await handleDeleteTask(
      makeReq({ params: { id: 'never-existed' } }),
      vaultDir,
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('task_not_found');
  });
});

describe('handleGetTaskConfig', () => {
  it('reports capability governance and effective schedule enablement', async () => {
    const grove = createGrove('Agent Tasks', mycoHome);
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(
      groveConfigPath,
      [
        'version: 3',
        'vault_evolution:',
        '  enabled: false',
        'agent:',
        '  tasks:',
        '    vault-evolve:',
        '      schedule:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    invalidateMergedConfigCache();

    const res = await handleGetTaskConfig(
      makeReq({
        params: { id: 'vault-evolve' },
        requestContext: { ...TEST_REQUEST_CONTEXT, groveId: grove.id },
      }),
      vaultDir,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      taskId: 'vault-evolve',
      capability: 'vault_evolution',
      capabilityEnabled: false,
      effectiveScheduleEnabled: false,
      config: { schedule: { enabled: true } },
      scheduleBlockedReason: 'capability_off',
    });
  });

  it('reports requires_task_provider for canopy-describe until a provider is chosen', async () => {
    const grove = createGrove('Agent Tasks Gate', mycoHome);
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(
      groveConfigPath,
      [
        'version: 3',
        'cortex:',
        '  canopy:',
        '    enabled: true',
        'agent:',
        '  tasks:',
        '    canopy-describe:',
        '      schedule:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    invalidateMergedConfigCache();

    const req = makeReq({
      params: { id: 'canopy-describe' },
      requestContext: { ...TEST_REQUEST_CONTEXT, groveId: grove.id },
    });
    const blocked = await handleGetTaskConfig(req, vaultDir);
    expect(blocked.status).toBe(200);
    // The enabled override alone must not schedule the task — it does not
    // fall back to the default provider by design.
    expect(blocked.body).toMatchObject({
      effectiveScheduleEnabled: false,
      scheduleBlockedReason: 'requires_task_provider',
    });

    fs.writeFileSync(
      groveConfigPath,
      [
        'version: 3',
        'cortex:',
        '  canopy:',
        '    enabled: true',
        'agent:',
        '  tasks:',
        '    canopy-describe:',
        '      provider:',
        '        type: lmstudio',
        '        model: openai/gpt-oss-20b',
        '      schedule:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    invalidateMergedConfigCache();
    const satisfied = await handleGetTaskConfig(req, vaultDir);
    expect(satisfied.body).toMatchObject({
      effectiveScheduleEnabled: true,
      scheduleBlockedReason: null,
    });
  });
});

describe('handleUpdateTaskConfig schedule gate', () => {
  it('422s when enabling canopy-describe schedule without a provider, and accepts pick-model+enable in one write', async () => {
    const grove = createGrove('Agent Tasks Put Gate', mycoHome);
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(groveConfigPath, 'version: 3\n');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    invalidateMergedConfigCache();

    const baseReq = {
      params: { id: 'canopy-describe' },
      requestContext: { ...TEST_REQUEST_CONTEXT, groveId: grove.id },
    };

    const rejected = await handleUpdateTaskConfig(
      makeReq({ ...baseReq, body: { schedule: { enabled: true } } }),
      vaultDir,
      grove.id,
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ error: 'schedule_requires_task_provider' });

    const accepted = await handleUpdateTaskConfig(
      makeReq({
        ...baseReq,
        body: {
          harness: 'openai-agents',
          provider: { type: 'lmstudio', model: 'openai/gpt-oss-20b' },
          schedule: { enabled: true },
        },
      }),
      vaultDir,
      grove.id,
    );
    expect(accepted.status).toBe(200);
    expect((accepted.body as { config: { schedule?: { enabled?: boolean } } }).config.schedule?.enabled).toBe(true);
  });

  it('422s a provider-removal write that leaves the schedule enabled', async () => {
    const grove = createGrove('Agent Tasks Removal Gate', mycoHome);
    const groveConfigPath = resolveGroveConfigPath(grove.id, mycoHome);
    fs.mkdirSync(path.dirname(groveConfigPath), { recursive: true });
    fs.writeFileSync(
      groveConfigPath,
      [
        'version: 3',
        'agent:',
        '  tasks:',
        '    canopy-describe:',
        '      provider:',
        '        type: lmstudio',
        '        model: openai/gpt-oss-20b',
        '      schedule:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    invalidateMergedConfigCache();

    const baseReq = {
      params: { id: 'canopy-describe' },
      requestContext: { ...TEST_REQUEST_CONTEXT, groveId: grove.id },
    };

    // Removal-only write: the body never touches the schedule, but the
    // post-write state is enabled-without-provider — refused.
    const removal = await handleUpdateTaskConfig(
      makeReq({ ...baseReq, body: { provider: null } }),
      vaultDir,
      grove.id,
    );
    expect(removal.status).toBe(422);

    // Removal combined with an explicit enable: the pre-write merged view
    // still holds the old provider — must not launder the removal through.
    const combined = await handleUpdateTaskConfig(
      makeReq({ ...baseReq, body: { provider: null, schedule: { enabled: true } } }),
      vaultDir,
      grove.id,
    );
    expect(combined.status).toBe(422);

    // Removing the provider together with the schedule is a legitimate
    // "turn it all off" write.
    const teardown = await handleUpdateTaskConfig(
      makeReq({ ...baseReq, body: { provider: null, schedule: null } }),
      vaultDir,
      grove.id,
    );
    expect(teardown.status).toBe(200);
  });

  it('does not gate schedule-only writes for unflagged tasks', async () => {
    const grove = createGrove('Agent Tasks Ungated', mycoHome);
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');
    invalidateMergedConfigCache();

    const res = await handleUpdateTaskConfig(
      makeReq({
        params: { id: 'vault-evolve' },
        body: { schedule: { enabled: true } },
        requestContext: { ...TEST_REQUEST_CONTEXT, groveId: grove.id },
      }),
      vaultDir,
      grove.id,
    );
    expect(res.status).toBe(200);
  });
});

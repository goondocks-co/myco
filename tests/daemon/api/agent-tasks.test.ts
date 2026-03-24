/**
 * Tests for agent-tasks API route handlers.
 *
 * Handlers are tested directly (no HTTP) by mocking the registry functions.
 * loadAgentTasks is mocked so tests don't depend on the real definitions dir.
 * resolveDefinitionsDir is mocked to return a sentinel path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/loader.js', () => ({
  loadAgentTasks: vi.fn(),
  resolveDefinitionsDir: vi.fn(() => '/fake/definitions'),
}));

import { loadAgentTasks } from '@myco/agent/loader.js';
import {
  handleListTasks,
  handleGetTask,
  handleCreateTask,
  handleCopyTask,
  handleDeleteTask,
} from '@myco/daemon/api/agent-tasks';
import type { AgentTask } from '@myco/agent/types.js';
import type { RouteRequest } from '@myco/daemon/router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RouteRequest. */
function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/api/agent/tasks',
    ...overrides,
  };
}

/** Build a minimal valid AgentTask. */
function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    name: 'test-task',
    displayName: 'Test Task',
    description: 'A task for testing',
    agent: 'myco-agent',
    prompt: 'Do the thing.',
    isDefault: false,
    ...overrides,
  };
}

/** Write a YAML file for a task into `vaultDir/tasks/`. */
function writeTaskYaml(vaultDir: string, task: AgentTask): void {
  const tasksDir = path.join(vaultDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const { isBuiltin: _isBuiltin, source: _source, ...serializable } = task;
  fs.writeFileSync(
    path.join(tasksDir, `${task.name}.yaml`),
    JSON.stringify(serializable),
    'utf-8',
  );
}

/** Create a temp directory for test isolation. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-tasks-test-'));
}

/** Remove a temp directory recursively. */
function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// handleListTasks
// ---------------------------------------------------------------------------

describe('handleListTasks', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('returns both built-in and user tasks', async () => {
    const builtIn = makeTask({ name: 'full-intelligence', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'my-custom-task' }));

      const result = await handleListTasks(makeReq(), vaultDir);

      expect(result.status).toBe(200);
      const tasks = result.body as AgentTask[];
      expect(tasks.length).toBe(2);
      const names = tasks.map((t) => t.name);
      expect(names).toContain('full-intelligence');
      expect(names).toContain('my-custom-task');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('filters by source=user', async () => {
    const builtIn = makeTask({ name: 'built-in-task', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'user-task' }));

      const result = await handleListTasks(makeReq({ query: { source: 'user' } }), vaultDir);

      expect(result.status).toBe(200);
      const tasks = result.body as AgentTask[];
      expect(tasks.length).toBe(1);
      expect(tasks[0].name).toBe('user-task');
      expect(tasks[0].source).toBe('user');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('filters by source=built-in', async () => {
    const builtIn = makeTask({ name: 'built-in-task', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'user-task' }));

      const result = await handleListTasks(
        makeReq({ query: { source: 'built-in' } }),
        vaultDir,
      );

      expect(result.status).toBe(200);
      const tasks = result.body as AgentTask[];
      expect(tasks.length).toBe(1);
      expect(tasks[0].name).toBe('built-in-task');
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// handleGetTask
// ---------------------------------------------------------------------------

describe('handleGetTask', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('returns task with phases when found', async () => {
    const task = makeTask({
      name: 'phased-task',
      phases: [
        { name: 'plan', prompt: 'Plan it', tools: [], maxTurns: 3, required: true },
      ],
    });
    vi.mocked(loadAgentTasks).mockReturnValue([task]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleGetTask(makeReq({ params: { id: 'phased-task' } }), vaultDir);

      expect(result.status).toBe(200);
      const body = result.body as AgentTask;
      expect(body.name).toBe('phased-task');
      expect(body.phases).toHaveLength(1);
      expect(body.phases![0].name).toBe('plan');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 404 for unknown task', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleGetTask(makeReq({ params: { id: 'nonexistent' } }), vaultDir);
      expect(result.status).toBe(404);
      expect((result.body as { error: string }).error).toBe('task_not_found');
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// handleCreateTask
// ---------------------------------------------------------------------------

describe('handleCreateTask', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('creates valid task and returns 201', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const body = {
        name: 'new-task',
        displayName: 'New Task',
        description: 'A brand new task',
        agent: 'myco-agent',
        prompt: 'Do the thing.',
        isDefault: false,
      };
      const result = await handleCreateTask(makeReq({ body }), vaultDir);

      expect(result.status).toBe(201);
      const created = result.body as AgentTask;
      expect(created.name).toBe('new-task');
      expect(created.source).toBe('user');

      // File should exist on disk
      expect(fs.existsSync(path.join(vaultDir, 'tasks', 'new-task.yaml'))).toBe(true);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 400 for invalid body (missing required fields)', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleCreateTask(makeReq({ body: { name: 'only-name' } }), vaultDir);
      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe('validation_failed');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 400 for invalid task name', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const body = {
        name: 'Invalid_Name',
        displayName: 'Bad',
        description: 'desc',
        agent: 'myco-agent',
        prompt: 'prompt',
        isDefault: false,
      };
      const result = await handleCreateTask(makeReq({ body }), vaultDir);
      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe('invalid_task_name');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 409 for duplicate user task', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      // Write an existing user task
      writeTaskYaml(vaultDir, makeTask({ name: 'existing-task' }));

      const body = {
        name: 'existing-task',
        displayName: 'Existing Task',
        description: 'already there',
        agent: 'myco-agent',
        prompt: 'Do something.',
        isDefault: false,
      };
      const result = await handleCreateTask(makeReq({ body }), vaultDir);
      expect(result.status).toBe(409);
      expect((result.body as { error: string }).error).toBe('task_already_exists');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('allows creating task with same name as built-in (override)', async () => {
    const builtIn = makeTask({ name: 'full-intelligence', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const body = {
        name: 'full-intelligence',
        displayName: 'My Full Intelligence',
        description: 'Override the built-in',
        agent: 'myco-agent',
        prompt: 'Custom prompt.',
        isDefault: false,
      };
      const result = await handleCreateTask(makeReq({ body }), vaultDir);
      // Should succeed — built-in can be shadowed
      expect(result.status).toBe(201);
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// handleCopyTask
// ---------------------------------------------------------------------------

describe('handleCopyTask', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('creates user copy with -custom suffix', async () => {
    const builtIn = makeTask({ name: 'full-intelligence', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleCopyTask(
        makeReq({ params: { id: 'full-intelligence' } }),
        vaultDir,
      );

      expect(result.status).toBe(201);
      const copy = result.body as AgentTask;
      expect(copy.name).toBe('full-intelligence-custom');
      expect(copy.isDefault).toBe(false);
      expect(copy.source).toBe('user');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('uses provided name when given', async () => {
    const builtIn = makeTask({ name: 'extract-only' });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleCopyTask(
        makeReq({ params: { id: 'extract-only' }, body: { name: 'my-extract' } }),
        vaultDir,
      );

      expect(result.status).toBe(201);
      const copy = result.body as AgentTask;
      expect(copy.name).toBe('my-extract');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 404 for unknown source task', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleCopyTask(
        makeReq({ params: { id: 'does-not-exist' } }),
        vaultDir,
      );
      expect(result.status).toBe(404);
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// handleDeleteTask
// ---------------------------------------------------------------------------

describe('handleDeleteTask', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('deletes user task and returns 200', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'removable-task' }));

      const result = await handleDeleteTask(
        makeReq({ params: { id: 'removable-task' } }),
        vaultDir,
      );

      expect(result.status).toBe(200);
      expect((result.body as { deleted: string }).deleted).toBe('removable-task');
      expect(fs.existsSync(path.join(vaultDir, 'tasks', 'removable-task.yaml'))).toBe(false);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 403 when attempting to delete a built-in task', async () => {
    const builtIn = makeTask({ name: 'full-intelligence', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleDeleteTask(
        makeReq({ params: { id: 'full-intelligence' } }),
        vaultDir,
      );

      expect(result.status).toBe(403);
      expect((result.body as { error: string }).error).toBe('cannot_delete_builtin');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns 404 for non-existent task', async () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      const result = await handleDeleteTask(
        makeReq({ params: { id: 'ghost-task' } }),
        vaultDir,
      );
      expect(result.status).toBe(404);
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

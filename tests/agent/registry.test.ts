/**
 * Tests for the user task registry.
 *
 * Uses fs.mkdtempSync for isolated temp directories. Built-in task loading
 * is mocked via vi.mock to avoid depending on the actual definitions directory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Mock loadAgentTasks so tests don't depend on the real definitions dir
// ---------------------------------------------------------------------------

vi.mock('@myco/agent/loader.js', () => ({
  loadAgentTasks: vi.fn(),
}));

import { loadAgentTasks } from '@myco/agent/loader.js';
import { loadAllTasks, validateTaskName, writeUserTask, deleteUserTask, copyTaskToUser } from '@myco/agent/registry.js';
import type { AgentTask } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for test isolation. Cleaned up in test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-test-'));
}

/** Remove a temp directory recursively. */
function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
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
    JSON.stringify(serializable), // JSON is valid YAML
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// loadAllTasks
// ---------------------------------------------------------------------------

describe('loadAllTasks', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('discovers built-in tasks from definitions dir', () => {
    const builtIn = makeTask({ name: 'full-intelligence', isDefault: true });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const tasks = loadAllTasks('/fake/definitions');

    expect(tasks.size).toBe(1);
    expect(tasks.has('full-intelligence')).toBe(true);
    expect(tasks.get('full-intelligence')!.source).toBe('built-in');
    expect(tasks.get('full-intelligence')!.isBuiltin).toBe(true);
  });

  it('discovers user tasks from vault tasks dir', () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);
    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'my-task' }));

      const tasks = loadAllTasks('/fake/definitions', vaultDir);

      expect(tasks.has('my-task')).toBe(true);
      expect(tasks.get('my-task')!.source).toBe('user');
      expect(tasks.get('my-task')!.isBuiltin).toBe(false);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('user task with same name overrides built-in', () => {
    const builtIn = makeTask({ name: 'digest-only', displayName: 'Built-in Digest' });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      writeTaskYaml(vaultDir, makeTask({ name: 'digest-only', displayName: 'User Digest' }));

      const tasks = loadAllTasks('/fake/definitions', vaultDir);

      expect(tasks.size).toBe(1);
      expect(tasks.get('digest-only')!.displayName).toBe('User Digest');
      expect(tasks.get('digest-only')!.source).toBe('user');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('skips malformed user task YAML without crashing', () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);
    const vaultDir = makeTempDir();
    try {
      const tasksDir = path.join(vaultDir, 'tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      // Write a YAML file that is missing required fields
      fs.writeFileSync(path.join(tasksDir, 'bad.yaml'), 'not: valid: task: yaml: : :', 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const tasks = loadAllTasks('/fake/definitions', vaultDir);
      warnSpy.mockRestore();

      expect(tasks.size).toBe(0);
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// validateTaskName
// ---------------------------------------------------------------------------

describe('validateTaskName', () => {
  it('accepts valid multi-word name', () => {
    expect(validateTaskName('my-task')).toBe(true);
  });

  it('accepts single character name', () => {
    expect(validateTaskName('a')).toBe(true);
  });

  it('accepts name with digits', () => {
    expect(validateTaskName('task-123')).toBe(true);
  });

  it('accepts name starting with digit', () => {
    expect(validateTaskName('1-task')).toBe(true);
  });

  it('rejects uppercase letters', () => {
    expect(validateTaskName('My-Task')).toBe(false);
  });

  it('rejects underscores', () => {
    expect(validateTaskName('task_name')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(validateTaskName('-leading')).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    expect(validateTaskName('trailing-')).toBe(false);
  });

  it('rejects names over 50 characters', () => {
    const longName = 'a'.repeat(51);
    expect(validateTaskName(longName)).toBe(false);
  });

  it('accepts name exactly at 50 characters', () => {
    // 48 chars + 2 boundary chars = 50
    const name = 'a' + 'b'.repeat(48) + 'c';
    expect(name.length).toBe(50);
    expect(validateTaskName(name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeUserTask
// ---------------------------------------------------------------------------

describe('writeUserTask', () => {
  it('creates YAML file in vault tasks dir', () => {
    const vaultDir = makeTempDir();
    try {
      const tasksDir = path.join(vaultDir, 'tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      const task = makeTask({ name: 'my-new-task' });
      const filePath = writeUserTask(vaultDir, task);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePath).toBe(path.join(tasksDir, 'my-new-task.yaml'));

      // Verify the YAML contains expected content
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      expect(parsed.name).toBe('my-new-task');
      expect(parsed.displayName).toBe('Test Task');
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('creates tasks dir if it does not exist', () => {
    const vaultDir = makeTempDir();
    try {
      const tasksDir = path.join(vaultDir, 'tasks');
      expect(fs.existsSync(tasksDir)).toBe(false);

      const task = makeTask({ name: 'auto-dir-task' });
      writeUserTask(vaultDir, task);

      expect(fs.existsSync(tasksDir)).toBe(true);
      expect(fs.existsSync(path.join(tasksDir, 'auto-dir-task.yaml'))).toBe(true);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('strips source and isBuiltin fields from YAML output', () => {
    const vaultDir = makeTempDir();
    try {
      const task = makeTask({ name: 'stripped-task', source: 'user', isBuiltin: false });
      const filePath = writeUserTask(vaultDir, task);

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      expect(parsed.source).toBeUndefined();
      expect(parsed.isBuiltin).toBeUndefined();
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// deleteUserTask
// ---------------------------------------------------------------------------

describe('deleteUserTask', () => {
  it('removes file and returns true', () => {
    const vaultDir = makeTempDir();
    try {
      const task = makeTask({ name: 'to-delete' });
      writeUserTask(vaultDir, task);

      const result = deleteUserTask(vaultDir, 'to-delete');

      expect(result).toBe(true);
      expect(fs.existsSync(path.join(vaultDir, 'tasks', 'to-delete.yaml'))).toBe(false);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('returns false for non-existent file', () => {
    const vaultDir = makeTempDir();
    try {
      const result = deleteUserTask(vaultDir, 'does-not-exist');
      expect(result).toBe(false);
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

// ---------------------------------------------------------------------------
// copyTaskToUser
// ---------------------------------------------------------------------------

describe('copyTaskToUser', () => {
  beforeEach(() => {
    vi.mocked(loadAgentTasks).mockReset();
  });

  it('creates user copy with -custom suffix', () => {
    const builtIn = makeTask({ name: 'full-intelligence', displayName: 'Full Intelligence' });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const copy = copyTaskToUser('/fake/definitions', vaultDir, 'full-intelligence');

      expect(copy.name).toBe('full-intelligence-custom');
      expect(copy.isDefault).toBe(false);
      expect(copy.isBuiltin).toBe(false);
      expect(copy.source).toBe('user');
      expect(fs.existsSync(path.join(vaultDir, 'tasks', 'full-intelligence-custom.yaml'))).toBe(true);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('uses custom name when provided', () => {
    const builtIn = makeTask({ name: 'extract-only' });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      const copy = copyTaskToUser('/fake/definitions', vaultDir, 'extract-only', 'my-extract');

      expect(copy.name).toBe('my-extract');
      expect(fs.existsSync(path.join(vaultDir, 'tasks', 'my-extract.yaml'))).toBe(true);
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('throws on invalid task name', () => {
    const builtIn = makeTask({ name: 'digest-only' });
    vi.mocked(loadAgentTasks).mockReturnValue([builtIn]);

    const vaultDir = makeTempDir();
    try {
      expect(() =>
        copyTaskToUser('/fake/definitions', vaultDir, 'digest-only', 'Invalid_Name'),
      ).toThrow();
    } finally {
      removeTempDir(vaultDir);
    }
  });

  it('throws when source task is not found', () => {
    vi.mocked(loadAgentTasks).mockReturnValue([]);

    const vaultDir = makeTempDir();
    try {
      expect(() =>
        copyTaskToUser('/fake/definitions', vaultDir, 'nonexistent'),
      ).toThrow('Task not found: nonexistent');
    } finally {
      removeTempDir(vaultDir);
    }
  });
});

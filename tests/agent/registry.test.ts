/**
 * Focused tests for the user-task registry helpers.
 *
 * Restores the security-relevant slice of the 355-line file pruned in #295:
 *  - validateTaskName guards against bad characters, dot-segments, and
 *    over-long names — it's the only pre-write gate against path traversal
 *    in copyTaskToUser / writeUserTask.
 *  - writeUserTask actually lands the YAML under vaultDir/tasks/.
 *  - copyTaskToUser uses the validated name and refuses unknown sources.
 *  - deleteUserTask removes the file and reports prior existence.
 *
 * No mocks — real fs against a temp vault. Built-in lookup paths are
 * exercised indirectly via copyTaskToUser; the "task not found" branch
 * doesn't depend on the resolved definitions dir so the assertion is
 * stable across dist/src layouts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateTaskName,
  writeUserTask,
  deleteUserTask,
  copyTaskToUser,
} from '@myco/agent/registry.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';
import type { AgentTask } from '@myco/agent/types.js';
import { MAX_TASK_NAME_LENGTH } from '@myco/constants.js';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    name: 'registry-test-task',
    displayName: 'Registry Test',
    description: 'A task used by registry tests',
    agent: 'myco-agent',
    prompt: 'Do the thing.',
    isDefault: false,
    ...overrides,
  } as AgentTask;
}

let vaultDir: string;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-registry-'));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('validateTaskName', () => {
  it('accepts lowercase letters, digits, and internal hyphens', () => {
    expect(validateTaskName('valid')).toBe(true);
    expect(validateTaskName('valid-name')).toBe(true);
    expect(validateTaskName('vault-evolve')).toBe(true);
    expect(validateTaskName('task1')).toBe(true);
    expect(validateTaskName('a1b2-c3d4')).toBe(true);
  });

  it('accepts single-character names', () => {
    expect(validateTaskName('a')).toBe(true);
    expect(validateTaskName('1')).toBe(true);
  });

  it('rejects uppercase, underscore, spaces, and other punctuation', () => {
    expect(validateTaskName('Bad')).toBe(false);
    expect(validateTaskName('bad_name')).toBe(false);
    expect(validateTaskName('bad name')).toBe(false);
    expect(validateTaskName('bad.name')).toBe(false);
    expect(validateTaskName('bad/name')).toBe(false);
  });

  it('rejects leading and trailing hyphens', () => {
    expect(validateTaskName('-leading')).toBe(false);
    expect(validateTaskName('trailing-')).toBe(false);
    expect(validateTaskName('-both-')).toBe(false);
  });

  it('rejects dot segments — the canonical path-traversal shape', () => {
    expect(validateTaskName('..')).toBe(false);
    expect(validateTaskName('.')).toBe(false);
    expect(validateTaskName('../escape')).toBe(false);
    expect(validateTaskName('a/../b')).toBe(false);
    expect(validateTaskName('a.b')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateTaskName('')).toBe(false);
  });

  it('enforces the length limit', () => {
    expect(validateTaskName('a'.repeat(MAX_TASK_NAME_LENGTH))).toBe(true);
    expect(validateTaskName('a'.repeat(MAX_TASK_NAME_LENGTH + 1))).toBe(false);
  });
});

describe('writeUserTask', () => {
  it('writes the YAML file under vaultDir/tasks/<name>.yaml', () => {
    const written = writeUserTask(vaultDir, makeTask({ name: 'wrote-me' }));
    expect(written).toBe(path.join(vaultDir, 'tasks', 'wrote-me.yaml'));
    expect(fs.existsSync(written)).toBe(true);
    const body = fs.readFileSync(written, 'utf-8');
    expect(body).toContain('name: wrote-me');
    expect(body).toContain('agent: myco-agent');
    // Internal-only fields must be stripped from the serialized output.
    expect(body).not.toContain('isBuiltin');
    expect(body).not.toContain('source:');
  });

  it('creates the tasks directory when missing (idempotent)', () => {
    expect(fs.existsSync(path.join(vaultDir, 'tasks'))).toBe(false);
    writeUserTask(vaultDir, makeTask({ name: 'first' }));
    writeUserTask(vaultDir, makeTask({ name: 'second' }));
    expect(fs.readdirSync(path.join(vaultDir, 'tasks')).sort()).toEqual(['first.yaml', 'second.yaml']);
  });
});

describe('deleteUserTask', () => {
  it('removes an existing task file and reports prior existence', () => {
    writeUserTask(vaultDir, makeTask({ name: 'about-to-die' }));
    const filePath = path.join(vaultDir, 'tasks', 'about-to-die.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(deleteUserTask(vaultDir, 'about-to-die')).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('returns false when the task file does not exist', () => {
    expect(deleteUserTask(vaultDir, 'never-existed')).toBe(false);
  });
});

describe('copyTaskToUser', () => {
  const definitionsDir = resolveDefinitionsDir();

  it('throws when the source task does not exist', () => {
    expect(() =>
      copyTaskToUser(definitionsDir, vaultDir, 'no-such-source', 'destination'),
    ).toThrow(/not found/i);
  });

  it('refuses an invalid override name even if the source exists', () => {
    writeUserTask(vaultDir, makeTask({ name: 'real-source' }));
    expect(() =>
      copyTaskToUser(definitionsDir, vaultDir, 'real-source', 'Bad Name'),
    ).toThrow(/invalid task name/i);
  });

  it('refuses dot-segment override names (path traversal guard)', () => {
    writeUserTask(vaultDir, makeTask({ name: 'real-source' }));
    expect(() =>
      copyTaskToUser(definitionsDir, vaultDir, 'real-source', '../escape'),
    ).toThrow(/invalid task name/i);
    expect(fs.existsSync(path.join(vaultDir, 'tasks', 'escape.yaml'))).toBe(false);
  });

  it('writes the copied task with the validated name under vault tasks/', () => {
    writeUserTask(vaultDir, makeTask({ name: 'real-source' }));
    const copy = copyTaskToUser(definitionsDir, vaultDir, 'real-source', 'new-copy');
    expect(copy.name).toBe('new-copy');
    expect(copy.isBuiltin).toBe(false);
    expect(copy.isDefault).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'tasks', 'new-copy.yaml'))).toBe(true);
  });

  it('falls back to <source>-custom when no override name is given', () => {
    writeUserTask(vaultDir, makeTask({ name: 'real-source' }));
    const copy = copyTaskToUser(definitionsDir, vaultDir, 'real-source');
    expect(copy.name).toBe('real-source-custom');
    expect(fs.existsSync(path.join(vaultDir, 'tasks', 'real-source-custom.yaml'))).toBe(true);
  });
});

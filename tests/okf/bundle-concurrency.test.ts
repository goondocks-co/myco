import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps } from '@myco/okf/bundle.js';
import type { OkfDocument } from '@myco/okf/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

// Ported from the legacy `maintain()`-driven locking suite onto
// `beginStagedGeneration` — the single-lock/timeout/exit-listener machinery is
// `acquireLock`/`releaseLock` inside `openStagedSession`, unchanged.

const AGENT_ID = 'claude-code';
const MACHINE_ID = 'test-machine-okf';
let projectRoot: string;
let projectId: string;

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  cleanTestDb();
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: 1_783_000_000 });
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-conc-')));
  projectId = createProjectId();
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function makeBundle(lockOptions?: { timeoutMs?: number; retryMs?: number }): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    now: () => new Date('2026-07-05T12:00:00Z'),
    lockOptions,
  };
  return new OkfBundle(deps);
}

function contentDoc(id: string): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: { type: 'note', title: id, description: 'A portable knowledge page.', timestamp: '2026-07-05T00:00:00Z' },
    body: `Body of ${id}.`,
  };
}

async function publish(bundle: OkfBundle, id: string) {
  const staged = await bundle.beginStagedGeneration({ mode: 'published' });
  staged.stageDocument(contentDoc(id));
  return staged.finalize({ inputsHash: `hash-${id}` });
}

describe('OkfBundle locking', () => {
  it('times out with a typed error naming the holder pid when the lock is held', async () => {
    // Hold the lock out-of-band in this same process (flock conflicts across
    // separate fds even within one process).
    const vault = new ProjectVault(projectRoot);
    vault.okfStateDir();
    const acquired = LifecycleLock.acquire(vault.okfLockPath());
    if (!acquired.acquired) throw new Error('precondition: could not acquire lock');
    try {
      const bundle = makeBundle({ timeoutMs: 250, retryMs: 50 });
      // beginStagedGeneration acquires the lock inside openStagedSession, so the
      // timeout surfaces on the open call itself.
      await expect(bundle.beginStagedGeneration({ mode: 'published' })).rejects.toMatchObject({
        code: 'okf_maintain_failed',
      });
      await expect(bundle.beginStagedGeneration({ mode: 'published' })).rejects.toThrow(new RegExp(String(process.pid)));
    } finally {
      acquired.lock.release();
      process.removeListener('exit', acquired.lock.release as unknown as NodeJS.ExitListener);
    }
  });

  it('completes once the lock is released', async () => {
    const result = await publish(makeBundle(), 'pages/alpha');
    expect(result.unchanged).toBe(false);
  });

  it('leaks no net exit listeners across repeated publishes', async () => {
    const before = process.listeners('exit').length;
    await publish(makeBundle(), 'pages/alpha');
    await publish(makeBundle(), 'pages/beta');
    await publish(makeBundle(), 'pages/gamma');
    expect(process.listeners('exit').length).toBe(before);
  });
});

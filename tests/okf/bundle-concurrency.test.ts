import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps } from '@myco/okf/bundle.js';
import type { OkfBundleWriteInput } from '@myco/okf/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

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

function seedSpore(id: string, content: string): void {
  insertSpore({
    id,
    project_id: projectId,
    agent_id: AGENT_ID,
    observation_type: 'decision',
    content,
    importance: 5,
    created_at: 1_783_000_000,
    updated_at: 1_783_100_000,
    machine_id: MACHINE_ID,
  });
}

function baseInput(over: Partial<OkfBundleWriteInput> = {}): OkfBundleWriteInput {
  return {
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectRoot,
    machineId: MACHINE_ID,
    mode: 'published',
    include: { spores: true, canopy: true, concepts: true, guides: true },
    sporeStatus: 'active',
    ...over,
  };
}

const VALID_CONCEPT =
  '---\n' +
  'type: Architecture Note\n' +
  'title: Locking Model\n' +
  'description: Why the bundle lock is async.\n' +
  'tags:\n  - okf\n' +
  'timestamp: 2026-07-05T00:00:00Z\n' +
  'myco_id: concepts/locking-model\n' +
  '---\n' +
  '\n' +
  'The lock retries acquisition.\n';

describe('OkfBundle locking', () => {
  it('times out with a typed error naming the holder pid when the lock is held', async () => {
    // Hold the lock out-of-band in this same process (flock conflicts across
    // separate fds even within one process).
    const vault = new ProjectVault(projectRoot);
    vault.okfStateDir();
    const acquired = LifecycleLock.acquire(vault.okfLockPath());
    if (!acquired.acquired) throw new Error('precondition: could not acquire lock');
    try {
      seedSpore('decision-1', 'A decision.');
      const bundle = makeBundle({ timeoutMs: 250, retryMs: 50 });
      await expect(bundle.maintain(baseInput())).rejects.toMatchObject({ code: 'okf_maintain_failed' });
      await expect(bundle.maintain(baseInput())).rejects.toThrow(new RegExp(String(process.pid)));
    } finally {
      acquired.lock.release();
      process.removeListener('exit', acquired.lock.release as unknown as NodeJS.ExitListener);
    }
  });

  it('completes once the lock is released', async () => {
    seedSpore('decision-1', 'A decision.');
    const result = await makeBundle().maintain(baseInput());
    expect(result.unchanged).toBe(false);
  });

  it('leaks no net exit listeners across repeated maintains', async () => {
    seedSpore('decision-1', 'A decision.');
    const before = process.listeners('exit').length;
    await makeBundle().maintain(baseInput());
    seedSpore('decision-2', 'Another.');
    await makeBundle().maintain(baseInput());
    seedSpore('decision-3', 'Third.');
    await makeBundle().maintain(baseInput());
    expect(process.listeners('exit').length).toBe(before);
  });
});

describe('OkfBundle concept mutation', () => {
  it('saveConcept adds a concept, bumps the generation, and leaves other files byte-identical', async () => {
    seedSpore('decision-1', 'A decision.');
    const bundle = makeBundle();
    await bundle.maintain(baseInput());

    const sporePath = path.join(projectRoot, 'okf/spores/decisions/decision-1.md');
    const guidePath = path.join(projectRoot, 'okf/guides/maintaining-this-bundle.md');
    const sporeBytes = fs.readFileSync(sporePath, 'utf8');
    const guideBytes = fs.readFileSync(guidePath, 'utf8');

    const result = await makeBundle().saveConcept({
      id: 'concepts/locking-model',
      markdown: VALID_CONCEPT,
      provenance: { actor: 'symbiont' },
    });

    expect(result.bundleGeneration).toBe(2);
    expect(fs.existsSync(path.join(projectRoot, 'okf/concepts/locking-model.md'))).toBe(true);
    // Deterministic projections are copied verbatim — byte-identical.
    expect(fs.readFileSync(sporePath, 'utf8')).toBe(sporeBytes);
    expect(fs.readFileSync(guidePath, 'utf8')).toBe(guideBytes);
    // The saved concept carries provenance.
    expect(fs.readFileSync(path.join(projectRoot, 'okf/concepts/locking-model.md'), 'utf8')).toContain(
      'myco_provenance',
    );
  });

  it('rejects a stale expectedGeneration with okf_generation_conflict', async () => {
    seedSpore('decision-1', 'A decision.');
    await makeBundle().maintain(baseInput());

    await expect(
      makeBundle().saveConcept({
        id: 'concepts/locking-model',
        markdown: VALID_CONCEPT,
        expectedGeneration: 0, // stale (real is 1)
        provenance: { actor: 'symbiont' },
      }),
    ).rejects.toMatchObject({ code: 'okf_generation_conflict', details: { currentGeneration: 1 } });
  });

  it('rejects editing a deterministic projection path', async () => {
    seedSpore('decision-1', 'A decision.');
    await makeBundle().maintain(baseInput());

    await expect(
      makeBundle().saveConcept({
        id: 'spores/decisions/decision-1',
        markdown: VALID_CONCEPT,
        provenance: { actor: 'symbiont' },
      }),
    ).rejects.toMatchObject({ code: 'deterministic_path_not_editable' });
  });

  it('supersedeConcept marks the old concept and requires the replacement to exist', async () => {
    seedSpore('decision-1', 'A decision.');
    await makeBundle().maintain(baseInput());
    await makeBundle().saveConcept({ id: 'concepts/old', markdown: VALID_CONCEPT.replace(/concepts\/locking-model/g, 'concepts/old'), provenance: { actor: 'cli' } });
    await makeBundle().saveConcept({ id: 'concepts/new', markdown: VALID_CONCEPT.replace(/concepts\/locking-model/g, 'concepts/new'), provenance: { actor: 'cli' } });

    // Missing replacement → rejected.
    await expect(
      makeBundle().supersedeConcept({ oldId: 'concepts/old', newId: 'concepts/ghost', reason: 'x', provenance: { actor: 'cli' } }),
    ).rejects.toMatchObject({ code: 'okf_validation_failed' });

    const result = await makeBundle().supersedeConcept({
      oldId: 'concepts/old',
      newId: 'concepts/new',
      reason: 'replaced by the new model',
      provenance: { actor: 'cli' },
    });
    expect(result.oldId).toBe('concepts/old');
    const oldContent = fs.readFileSync(path.join(projectRoot, 'okf/concepts/old.md'), 'utf8');
    expect(oldContent).toContain('status: superseded');
    expect(oldContent).toContain('superseded_by: concepts/new');
  });
});

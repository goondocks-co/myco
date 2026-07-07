import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps, type OkfFsOps } from '@myco/okf/bundle.js';
import type { OkfBundleWriteInput, OkfDocument } from '@myco/okf/types.js';
import type { OkfGatherResult } from '@myco/okf/gather.js';
import { fixtureRenderDocuments, invalidFixtureRenderDocuments } from '../helpers/okf-fixture.js';
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
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-fail-')));
  projectId = createProjectId();
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function realFsOps(): OkfFsOps {
  return {
    rename: (from, to) => fs.renameSync(from, to),
    rm: (t, o) => fs.rmSync(t, o),
    mkdir: (t, o) => {
      fs.mkdirSync(t, o);
    },
    stat: (t) => fs.statSync(t),
  };
}

function makeBundle(
  fsOps?: OkfFsOps,
  renderDocuments: (g: OkfGatherResult) => OkfDocument[] = fixtureRenderDocuments,
): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    now: () => new Date('2026-07-05T12:00:00Z'),
    fsOps,
    renderDocuments,
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

const okfDir = () => path.join(projectRoot, 'okf');
const manifest = () => new ProjectVault(projectRoot).readOkfManifest();

/** fsOps that delegates to real fs but can inject failures at chosen points. */
function injectable(hooks: {
  onRename?: (from: string, to: string) => Error | void;
  onRm?: (target: string) => Error | void;
}): OkfFsOps {
  const base = realFsOps();
  return {
    rename(from, to) {
      const err = hooks.onRename?.(from, to);
      if (err) throw err;
      base.rename(from, to);
    },
    rm(target, opts) {
      const err = hooks.onRm?.(target);
      if (err) throw err;
      base.rm(target, opts);
    },
    mkdir: base.mkdir,
    stat: base.stat,
  };
}

describe('OkfBundle failure injection', () => {
  it('final-rename failure rolls back and leaves the previous bundle intact', async () => {
    seedSpore('decision-1', 'First decision.');
    await makeBundle().maintain(baseInput());
    expect(manifest()?.bundle_generation).toBe(1);
    const conceptPath = path.join(okfDir(), 'spores/decisions/decision-1.md');
    const before = fs.readFileSync(conceptPath, 'utf8');

    seedSpore('decision-2', 'Second decision changes the inputs.');
    // Fail only the staging→final swap; the backup→final rollback (from a
    // state/backup- dir) must still succeed.
    const bundle = makeBundle(
      injectable({
        onRename: (from, to) => {
          if (to === okfDir() && from.includes(`${path.sep}staging${path.sep}`)) {
            const e = new Error('injected final rename') as NodeJS.ErrnoException;
            e.code = 'EIO';
            return e;
          }
        },
      }),
    );

    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({ code: 'atomic_replace_failed' });
    expect(manifest()?.last_result).toBe('rolled_back');
    expect(manifest()?.bundle_generation).toBe(1); // not incremented
    expect(fs.readFileSync(conceptPath, 'utf8')).toBe(before); // previous bundle restored
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-2.md'))).toBe(false);
  });

  it('backup-rename failure leaves the previous bundle intact (nothing moved yet)', async () => {
    seedSpore('decision-1', 'First decision.');
    await makeBundle().maintain(baseInput());
    const conceptPath = path.join(okfDir(), 'spores/decisions/decision-1.md');
    const before = fs.readFileSync(conceptPath, 'utf8');

    seedSpore('decision-2', 'Second decision.');
    // Fail the live→backup rename (to a state/backup- dir). The final swap is
    // never reached, so the live bundle is untouched.
    const bundle = makeBundle(
      injectable({
        onRename: (_from, to) => {
          if (to.includes(`${path.sep}backup-`)) {
            const e = new Error('injected backup rename') as NodeJS.ErrnoException;
            e.code = 'EIO';
            return e;
          }
        },
      }),
    );
    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({
      code: 'atomic_replace_failed',
      details: { lastResult: 'rolled_back' },
    });
    expect(manifest()?.bundle_generation).toBe(1); // not incremented
    expect(fs.readFileSync(conceptPath, 'utf8')).toBe(before); // previous bundle intact
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-2.md'))).toBe(false);
  });

  it('rollback failure records rollback_failed and throws atomic_replace_failed', async () => {
    seedSpore('decision-1', 'First decision.');
    await makeBundle().maintain(baseInput());

    seedSpore('decision-2', 'Second decision.');
    // Fail every rename targeting the final root — both the swap and the rollback.
    const bundle = makeBundle(
      injectable({
        onRename: (_from, to) => {
          if (to === okfDir()) {
            const e = new Error('injected') as NodeJS.ErrnoException;
            e.code = 'EIO';
            return e;
          }
        },
      }),
    );

    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({
      code: 'atomic_replace_failed',
      details: { lastResult: 'rollback_failed' },
    });
    expect(manifest()?.last_result).toBe('rollback_failed');
  });

  it('first-publish final-rename failure yields a clean no-bundle state', async () => {
    seedSpore('decision-1', 'A decision.');
    const bundle = makeBundle(
      injectable({
        onRename: (from, to) => {
          if (to === okfDir() && from.includes(`${path.sep}staging${path.sep}`)) {
            const e = new Error('injected') as NodeJS.ErrnoException;
            e.code = 'EIO';
            return e;
          }
        },
      }),
    );
    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({ code: 'atomic_replace_failed' });
    expect(manifest()?.last_result).toBe('rolled_back');
    // No partial bundle left behind.
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(false);
  });

  it('backup-cleanup failure records cleanup_pending and the next run sweeps it', async () => {
    seedSpore('decision-1', 'First decision.');
    await makeBundle().maintain(baseInput());

    seedSpore('decision-2', 'Second decision.');
    const bundle = makeBundle(
      injectable({
        onRm: (target) => {
          if (target.includes(`${path.sep}backup-`)) return new Error('injected backup rm');
        },
      }),
    );
    const result = await bundle.maintain(baseInput());
    expect(result.warnings.some((w) => w.code === 'cleanup_pending')).toBe(true);
    expect(manifest()?.last_result).toBe('cleanup_pending');
    expect(manifest()?.bundle_generation).toBe(2); // bundle IS published

    // A stale backup remains; the next (unchanged) run's sweep removes it.
    const stateDir = path.join(projectRoot, '.myco/okf/state');
    expect(fs.readdirSync(stateDir).some((n) => n.startsWith('backup-'))).toBe(true);
    seedSpore('decision-3', 'Third decision forces a new run.');
    await makeBundle().maintain(baseInput());
    expect(fs.readdirSync(stateDir).some((n) => n.startsWith('backup-'))).toBe(false);
  });

  it('retries a rename on EBUSY and then succeeds (Windows-style transient lock)', async () => {
    seedSpore('decision-1', 'A decision.');
    let failsLeft = 1;
    const bundle = makeBundle(
      injectable({
        onRename: (_from, to) => {
          if (to === okfDir() && failsLeft > 0) {
            failsLeft -= 1;
            const e = new Error('injected EBUSY') as NodeJS.ErrnoException;
            e.code = 'EBUSY';
            return e;
          }
        },
      }),
    );
    const result = await bundle.maintain(baseInput());
    expect(result.unchanged).toBe(false);
    expect(failsLeft).toBe(0);
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(true);
  });

  it('validation failure keeps the previous bundle intact and does not increment generation', async () => {
    seedSpore('decision-1', 'A good decision.');
    await makeBundle().maintain(baseInput());
    expect(manifest()?.bundle_generation).toBe(1);

    // A run whose rendered document fails strict validation (structure-breaking
    // frontmatter) must reject at finalize, AFTER staging but BEFORE the swap.
    // A new spore forces a changed (non-short-circuited) run.
    seedSpore('decision-2', 'Second decision forces a real run.');
    await expect(makeBundle(undefined, invalidFixtureRenderDocuments).maintain(baseInput())).rejects.toMatchObject({
      code: 'okf_validation_failed',
    });
    // Generation unchanged; the good prior bundle is still present.
    expect(manifest()?.bundle_generation).toBe(1);
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-1.md'))).toBe(true);
  });

  it('adopts a crashed marker generation greater than the manifest on the next run', async () => {
    seedSpore('decision-1', 'A decision.');
    await makeBundle().maintain(baseInput());

    // Simulate a crash between the final rename and the manifest commit: the
    // published marker records a higher generation than the manifest.
    const markerPath = path.join(okfDir(), '.myco-okf-maintain.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.bundle_generation = 5;
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    seedSpore('decision-2', 'Second decision forces a real run.');
    const result = await makeBundle().maintain(baseInput());
    expect(result.warnings.some((w) => w.code === 'crash_recovery')).toBe(true);
    expect(manifest()?.bundle_generation).toBe(6); // adopted marker gen (5) + 1
  });
});

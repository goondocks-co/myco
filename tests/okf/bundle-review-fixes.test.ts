/**
 * Regression tests for OKF Phase 1 review-pass fixes #2, #3, #5, #6, #7.
 *
 * Ported from the legacy `maintain()`-driven harness onto the staged-generation
 * entry point (`beginStagedGeneration`/`stageDocument`/`finalize`) after the
 * synchronous maintain surface was removed — the (code,path,hash) acknowledge
 * keying, crash-window recovery, absolute-path-safe errors, capability gate,
 * and generation-drift reconciliation are unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, OkfError, type OkfBundleDeps, type OkfFsOps } from '@myco/okf/bundle.js';
import type { OkfDocument } from '@myco/okf/types.js';
import { scanStagedBundle } from '@myco/okf/publish-eligibility.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

const AGENT_ID = 'claude-code';
const MACHINE_ID = 'test-machine-okf';
let projectRoot: string;
let projectId: string;

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  cleanTestDb();
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: 1_783_000_000 });
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-review-')));
  projectId = createProjectId();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true }, ...overrides });
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

/** fsOps that delegates to real fs but can inject failures at chosen points. */
function injectable(hooks: { onRename?: (from: string, to: string) => Error | void }): OkfFsOps {
  const base = realFsOps();
  return {
    rename(from, to) {
      const err = hooks.onRename?.(from, to);
      if (err) throw err;
      base.rename(from, to);
    },
    rm: base.rm,
    mkdir: base.mkdir,
    stat: base.stat,
  };
}

function makeBundle(cfg: MycoConfig = config(), fsOps?: OkfFsOps): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: cfg,
    now: () => new Date('2026-07-05T12:00:00Z'),
    fsOps,
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

function secretDoc(id: string, secret: string): OkfDocument {
  return { ...contentDoc(id), body: `A decision mentioning a key ${secret} inline.` };
}

async function publish(bundle: OkfBundle, doc: OkfDocument, opts: { acknowledgePublish?: boolean } = {}) {
  const staged = await bundle.beginStagedGeneration({ mode: 'published', acknowledgePublish: opts.acknowledgePublish });
  staged.stageDocument(doc);
  return staged.finalize({ inputsHash: `hash-${doc.path}` });
}

function okfDir(): string {
  return path.join(projectRoot, 'okf');
}

// ---------------------------------------------------------------------------
// #2 Publish-eligibility ack bypass
// ---------------------------------------------------------------------------

describe('#2 publish-eligibility ack — scanner hash', () => {
  const AWS_KEY_A = 'AKIAIOSFODNN7EXAMPLE';
  const AWS_KEY_B = 'AKIAJJJJJJJJJJEXAMPL';

  function write(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const CLEAN =
    '---\ntype: decision\ntitle: T\ndescription: D\ntimestamp: 2026-07-05\nmyco_id: d1\n---\n\nA normal decision about retries.\n';

  it('findings include a hash, and different secrets at the same (code, path) shape yield different hashes', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-hash-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-hash-b-'));
    try {
      write(rootA, 'spores/decisions/d1.md', CLEAN.replace('retries.', `retries. key ${AWS_KEY_A} here`));
      write(rootB, 'spores/decisions/d1.md', CLEAN.replace('retries.', `retries. key ${AWS_KEY_B} here`));

      const findingsA = scanStagedBundle(rootA);
      const findingsB = scanStagedBundle(rootB);

      expect(findingsA).toHaveLength(1);
      expect(findingsB).toHaveLength(1);
      expect(typeof findingsA[0].hash).toBe('string');
      expect(findingsA[0].hash.length).toBeGreaterThan(0);
      expect(findingsA[0].code).toBe('likely_secret');
      expect(findingsB[0].code).toBe('likely_secret');
      // Different secret content -> different hash.
      expect(findingsA[0].hash).not.toBe(findingsB[0].hash);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('the same secret produces the same hash', () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-hash-same1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-hash-same2-'));
    try {
      write(root1, 'spores/decisions/d1.md', CLEAN.replace('retries.', `retries. key ${AWS_KEY_A} here`));
      write(root2, 'spores/decisions/d1.md', CLEAN.replace('retries.', `retries. key ${AWS_KEY_A} here`));
      const f1 = scanStagedBundle(root1);
      const f2 = scanStagedBundle(root2);
      expect(f1[0].hash).toBe(f2[0].hash);
    } finally {
      fs.rmSync(root1, { recursive: true, force: true });
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('#2 publish-eligibility ack — end-to-end bypass closed', () => {
  const AWS_KEY_A = 'AKIAIOSFODNN7EXAMPLE';
  const AWS_KEY_B = 'AKIAJJJJJJJJJJEXAMPL';

  it('acknowledging secret A does not suppress a DIFFERENT secret B at the same page path', async () => {
    const first = await publish(makeBundle(), secretDoc('pages/leaky', AWS_KEY_A), { acknowledgePublish: true });
    expect(first.unchanged).toBe(false);
    expect(fs.existsSync(path.join(okfDir(), 'pages/leaky.md'))).toBe(true);

    // Same page path, but the body now carries a DIFFERENT secret. Without the
    // fix (ack keyed on code+path only), this would NOT throw and the new secret
    // would silently publish. With the fix, the new hash at the same (code, path)
    // is unacknowledged and re-blocks.
    await expect(publish(makeBundle(), secretDoc('pages/leaky', AWS_KEY_B))).rejects.toMatchObject({
      code: 'okf_publish_not_acknowledged',
    });
  });
});

// ---------------------------------------------------------------------------
// #3 Crash-window recovery
// ---------------------------------------------------------------------------

describe('#3 recoverOrphanedBundle — crash between atomicReplace renames', () => {
  it('restores the previous bundle from a surviving backup-N dir when outputRoot is empty', async () => {
    await publish(makeBundle(), contentDoc('pages/alpha'));
    const conceptPath = path.join(okfDir(), 'pages/alpha.md');
    expect(fs.existsSync(conceptPath)).toBe(true);
    const markerPath = path.join(okfDir(), '.myco-okf-maintain.json');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Simulate a crash between the two atomicReplace renames: move the live
    // bundle (which HAS the marker) aside to a backup-N dir under
    // .myco/okf/state, leaving outputRoot missing entirely.
    const stateDir = path.join(projectRoot, '.myco/okf/state');
    fs.mkdirSync(stateDir, { recursive: true });
    const backupPath = path.join(stateDir, 'backup-2');
    fs.renameSync(okfDir(), backupPath);

    expect(fs.existsSync(okfDir())).toBe(false);
    expect(fs.existsSync(path.join(backupPath, '.myco-okf-maintain.json'))).toBe(true);

    // The next run's recoverOrphanedBundle restores the bundle before staging.
    const result = await publish(makeBundle(), contentDoc('pages/beta'));

    // The bundle reappeared at outputRoot (restored, not silently lost).
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(conceptPath)).toBe(true);
    // The backup is no longer left dangling once recovery + the run complete.
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(result.warnings.some((w) => w.code === 'crash_recovery')).toBe(true);
  });

  it('does not silently delete the backup and leave outputRoot empty', async () => {
    await publish(makeBundle(), contentDoc('pages/alpha'));

    const stateDir = path.join(projectRoot, '.myco/okf/state');
    fs.mkdirSync(stateDir, { recursive: true });
    const backupPath = path.join(stateDir, 'backup-2');
    fs.renameSync(okfDir(), backupPath);

    await publish(makeBundle(), contentDoc('pages/beta'));

    // outputRoot is NOT empty/missing after the run.
    expect(fs.existsSync(okfDir())).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #5 Absolute-path leak in errors
// ---------------------------------------------------------------------------

describe('#5 errCode — atomic_replace_failed never leaks an absolute path', () => {
  it('injects a rename failure whose message embeds an absolute path; the thrown error omits it and includes the errno code', async () => {
    await publish(makeBundle(), contentDoc('pages/alpha'));

    const bundle = makeBundle(
      config(),
      injectable({
        onRename: (from, to) => {
          if (to === okfDir() && from.includes(`${path.sep}staging${path.sep}`)) {
            const e = new Error('rename failed: /Users/victim/secret/okf -> /Users/victim/secret/okf') as NodeJS.ErrnoException;
            e.code = 'EACCES';
            return e;
          }
        },
      }),
    );

    let caught: unknown;
    try {
      await publish(bundle, contentDoc('pages/beta'));
      throw new Error('expected finalize() to reject');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OkfError);
    const okfErr = caught as OkfError;
    expect(okfErr.code).toBe('atomic_replace_failed');
    expect(okfErr.message).not.toContain('/Users/');
    expect(okfErr.message).not.toContain('victim');
    expect(okfErr.message).toContain('EACCES');
  });
});

// ---------------------------------------------------------------------------
// #6 mode:'local' capability gate
// ---------------------------------------------------------------------------

describe("#6 capability gate applies to mode:'local' too", () => {
  it("throws okf_disabled for a mode:'local' write when the capability is disabled", async () => {
    const bundle = makeBundle(config({ okf: { enabled: false } }));
    await expect(bundle.beginStagedGeneration({ mode: 'local' })).rejects.toMatchObject({ code: 'okf_disabled' });
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf/bundle'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #7 Generation drift reconciliation
// ---------------------------------------------------------------------------

describe('#7 reconcileGenerationWithMarker — status() reports the marker generation, not a stale manifest', () => {
  it("status().bundleGeneration reflects the marker's generation when the manifest is behind", async () => {
    await publish(makeBundle(), contentDoc('pages/alpha'));

    const manifestPath = path.join(projectRoot, '.myco/okf/state/manifest.json');
    const markerPath = path.join(okfDir(), '.myco-okf-maintain.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const markerGen = marker.bundle_generation as number;
    expect(markerGen).toBe(1);

    // Bump the marker ahead of the manifest to simulate drift, then hand-edit
    // the manifest to fall BEHIND it.
    marker.bundle_generation = markerGen + 4; // marker now at 5
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    const manifestOnDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifestOnDisk.bundle_generation).toBe(1); // stale, behind the marker's 5
    fs.writeFileSync(manifestPath, JSON.stringify(manifestOnDisk, null, 2));

    const status = makeBundle().status();
    expect(status.bundleGeneration).toBe(5); // adopts the marker's higher generation
    expect(status.bundleGeneration).not.toBe(manifestOnDisk.bundle_generation);
  });
});

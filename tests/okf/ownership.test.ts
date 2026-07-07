import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps } from '@myco/okf/bundle.js';
import { isHandEdited, readOwnership } from '@myco/okf/ownership.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import type { OkfDocument } from '@myco/okf/types.js';
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
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-ownership-')));
  projectId = createProjectId();
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function makeBundle(): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    now: () => new Date('2026-07-05T12:00:00Z'),
  };
  return new OkfBundle(deps);
}

function contentDoc(id: string): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: {
      type: 'note',
      title: id,
      description: 'A portable knowledge page.',
      timestamp: '2026-07-05T00:00:00Z',
    },
    body: `Body of ${id}.`,
  };
}

const okfDir = () => path.join(projectRoot, 'okf');
const vault = () => new ProjectVault(projectRoot);

describe('OKF ownership manifest', () => {
  it('after finalize, readOwnership lists Myco-authored pages with fingerprints', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('pages/alpha'));
    staged.stageDocument(contentDoc('pages/beta'));
    await staged.finalize({ inputsHash: 'gen-1' });

    const ownership = readOwnership(vault());
    expect(ownership?.bundleGeneration).toBe(1);
    expect(Object.keys(ownership?.pages ?? {}).sort()).toEqual(['pages/alpha.md', 'pages/beta.md']);

    const alphaContent = fs.readFileSync(path.join(okfDir(), 'pages/alpha.md'), 'utf8');
    expect(ownership?.pages['pages/alpha.md'].fingerprint).toBe(sha256Hex(alphaContent));
    expect(ownership?.pages['pages/alpha.md'].generatedAt).toBe('2026-07-05T12:00:00.000Z');
  });

  it('editing a published page marks it hand-edited', async () => {
    const staged = await makeBundle().beginStagedGeneration({ mode: 'published' });
    staged.stageDocument(contentDoc('pages/alpha'));
    await staged.finalize({ inputsHash: 'gen-1' });

    const ownership = readOwnership(vault());
    const alphaPath = path.join(okfDir(), 'pages/alpha.md');
    const original = fs.readFileSync(alphaPath, 'utf8');
    expect(isHandEdited('pages/alpha.md', original, ownership)).toBe(false);

    const edited = `${original}\nHand-edited addendum.\n`;
    fs.writeFileSync(alphaPath, edited);
    expect(isHandEdited('pages/alpha.md', edited, ownership)).toBe(true);

    // A page ownership never heard of isn't "hand-edited" in the tracked sense.
    expect(isHandEdited('pages/unknown.md', 'anything', ownership)).toBe(false);
  });

  it('a crash between atomic-replace and ownership-write reconciles to the on-disk generation on the next session open', async () => {
    const bundle = makeBundle();

    // Generation 1: alpha only.
    const first = await bundle.beginStagedGeneration({ mode: 'published' });
    first.stageDocument(contentDoc('pages/alpha'));
    await first.finalize({ inputsHash: 'gen-1' });
    expect(readOwnership(vault())?.bundleGeneration).toBe(1);

    // Generation 2: alpha + beta. This finalize completes normally (atomic
    // swap, manifest write, and ownership write all land) — capture what a
    // real generation-2 ownership file looks like as the "ground truth" the
    // recovery path must reproduce.
    const second = await bundle.beginStagedGeneration({ mode: 'published' });
    second.stageDocument(contentDoc('pages/alpha'));
    second.stageDocument(contentDoc('pages/beta'));
    await second.finalize({ inputsHash: 'gen-2' });
    const groundTruth = readOwnership(vault());
    expect(groundTruth?.bundleGeneration).toBe(2);

    // Simulate the crash: generation 2 is fully live on disk (marker +
    // manifest both say gen 2) but the ownership write for that publish never
    // landed — what's left on disk is the stale generation-1 snapshot.
    const staleFromGen1: NonNullable<ReturnType<typeof readOwnership>> = {
      bundleGeneration: 1,
      pages: { 'pages/alpha.md': { fingerprint: 'stale-fingerprint', generatedAt: '2026-07-05T12:00:00.000Z' } },
    };
    fs.writeFileSync(vault().okfOwnershipPath(), `${JSON.stringify(staleFromGen1, null, 2)}\n`);
    expect(readOwnership(vault())?.bundleGeneration).toBe(1);

    // Opening the next session — before any new finalize — must reconcile
    // ownership to the ON-DISK generation (2), not leave the stale gen-1 data
    // and not report an empty/orphaned file.
    const recovery = await bundle.beginStagedGeneration({ mode: 'published' });
    recovery.abort();

    const reconciled = readOwnership(vault());
    expect(reconciled?.bundleGeneration).toBe(2);
    expect(Object.keys(reconciled?.pages ?? {}).sort()).toEqual(['pages/alpha.md', 'pages/beta.md']);
    const betaContent = fs.readFileSync(path.join(okfDir(), 'pages/beta.md'), 'utf8');
    expect(reconciled?.pages['pages/beta.md'].fingerprint).toBe(sha256Hex(betaContent));
    expect(reconciled).toEqual(groundTruth);
  });
});

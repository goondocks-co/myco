import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, type OkfBundleDeps } from '@myco/okf/bundle.js';
import type { OkfDocument } from '@myco/okf/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

// Ported from the legacy `maintain()`-driven suite onto the staged-generation
// entry point (`beginStagedGeneration`/`stageDocument`/`finalize`) after the
// synchronous maintain surface was removed — the underlying capability gate,
// publish-eligibility/acknowledge, and output-root-change machinery is
// unchanged, it is just driven by staging documents directly instead of a
// gather→render fixture. See tests/okf/staged-generation.test.ts for the
// crash-recovery/atomic-replace/incremental peers.

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
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-bundle-')));
  projectId = createProjectId();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true }, ...overrides });
}

function makeBundle(cfg: MycoConfig = config(), now = () => new Date('2026-07-05T12:00:00Z')): OkfBundle {
  const deps: OkfBundleDeps = {
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: cfg,
    now,
  };
  return new OkfBundle(deps);
}

function contentDoc(id: string, over: Partial<OkfDocument['frontmatter']> = {}): OkfDocument {
  return {
    path: `${id}.md`,
    frontmatter: {
      type: 'note',
      title: id,
      description: 'A portable knowledge page.',
      timestamp: '2026-07-05T00:00:00Z',
      ...over,
    },
    body: `Body of ${id}.`,
  };
}

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_KEY_B = 'AKIAJJJJJJJJJJEXAMPL';

/** A content doc whose BODY trips the publish-eligibility scanner (inline secret → likely_secret). */
function secretDoc(id: string, secret = AWS_KEY): OkfDocument {
  return { ...contentDoc(id), body: `A decision mentioning a key ${secret} inline.` };
}

function okfDir(): string {
  return path.join(projectRoot, 'okf');
}

async function publish(
  bundle: OkfBundle,
  docs: OkfDocument[],
  opts: { acknowledgePublish?: boolean; dryRun?: boolean; mode?: 'published' | 'local' } = {},
) {
  const staged = await bundle.beginStagedGeneration({
    mode: opts.mode ?? 'published',
    acknowledgePublish: opts.acknowledgePublish,
    dryRun: opts.dryRun,
  });
  for (const doc of docs) staged.stageDocument(doc);
  return staged.finalize({ inputsHash: 'test-hash' });
}

describe('OkfBundle staged generation — happy path', () => {
  it('produces a valid bundle tree with the expected shape', async () => {
    const result = await publish(makeBundle(), [contentDoc('spores/decision-1'), contentDoc('guides/overview')]);

    expect(result.unchanged).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'log.md'))).toBe(true);
    // The KEPT marker filename — renaming it would orphan existing bundles.
    expect(fs.existsSync(path.join(okfDir(), '.myco-okf-maintain.json'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'spores/decision-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'guides/overview.md'))).toBe(true);
    // The whole tree passes strict from disk.
    expect(makeBundle().validate().ok).toBe(true);
  });

  it('dry-run writes no published bundle', async () => {
    const result = await publish(makeBundle(), [contentDoc('pages/alpha')], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(okfDir())).toBe(false);
  });

  it('publishes with cortex.enabled=false (OKF does not depend on Cortex)', async () => {
    const result = await publish(makeBundle(config({ cortex: { enabled: false } })), [contentDoc('pages/alpha')]);
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'pages/alpha.md'))).toBe(true);
  });
});

describe('OkfBundle staged generation — capability gate', () => {
  it('throws okf_disabled and writes nothing when the capability is off', async () => {
    const bundle = makeBundle(config({ okf: { enabled: false } }));
    await expect(bundle.beginStagedGeneration({ mode: 'published' })).rejects.toMatchObject({ code: 'okf_disabled' });
    expect(fs.existsSync(okfDir())).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf'))).toBe(false);
  });

  it('allows dry-run while the capability is off', async () => {
    const result = await publish(makeBundle(config({ okf: { enabled: false } })), [contentDoc('pages/alpha')], {
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(okfDir())).toBe(false);
  });

  it("throws okf_disabled for a mode:'local' write when the capability is disabled", async () => {
    const bundle = makeBundle(config({ okf: { enabled: false } }));
    await expect(bundle.beginStagedGeneration({ mode: 'local' })).rejects.toMatchObject({ code: 'okf_disabled' });
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf/bundle'))).toBe(false);
  });
});

describe('OkfBundle.status / validate — no writes', () => {
  it('status and validate on a disabled fresh project create nothing', () => {
    const before = fs.existsSync(path.join(projectRoot, '.myco'));
    const bundle = makeBundle(config({ okf: { enabled: false } }));
    const status = bundle.status();
    expect(status.bundleExists).toBe(false);
    expect(status.bundleGeneration).toBeNull();
    bundle.validate();
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco'))).toBe(before);
  });
});

describe('OkfBundle staged generation — publish eligibility', () => {
  it('blocks first publish on an unacknowledged finding, then acknowledges and persists', async () => {
    await expect(publish(makeBundle(), [secretDoc('pages/leaky')])).rejects.toMatchObject({
      code: 'okf_publish_not_acknowledged',
    });
    expect(fs.existsSync(okfDir())).toBe(false);

    const ok = await publish(makeBundle(), [secretDoc('pages/leaky')], { acknowledgePublish: true });
    expect(ok.unchanged).toBe(false);
    expect(fs.existsSync(path.join(okfDir(), 'pages/leaky.md'))).toBe(true);

    // The acknowledgement persisted — a re-run with the SAME finding is not re-blocked.
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.acknowledged_findings.some((f) => f.code === 'likely_secret')).toBe(true);
  });

  it('re-blocks when a NEW distinct finding appears', async () => {
    await publish(makeBundle(), [secretDoc('pages/leaky', AWS_KEY)], { acknowledgePublish: true });

    // A second page carries a DIFFERENT secret; the first (leaky) is carried
    // forward already-acknowledged, so only the new finding blocks.
    await expect(publish(makeBundle(), [secretDoc('pages/other', AWS_KEY_B)])).rejects.toMatchObject({
      code: 'okf_publish_not_acknowledged',
    });
  });

  it('never blocks a local-mode bundle', async () => {
    const result = await publish(makeBundle(), [secretDoc('pages/leaky')], { mode: 'local' });
    expect(result.publishEligibility?.ok).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf/bundle/pages/leaky.md'))).toBe(true);
  });
});

describe('OkfBundle staged generation — output root change', () => {
  it('resets generation and warns when the output root changes', async () => {
    await publish(makeBundle(), [contentDoc('pages/alpha')]);
    const genBefore = new ProjectVault(projectRoot).readOkfManifest()?.bundle_generation;
    expect(genBefore).toBe(1);

    // Point at a different published path.
    const result = await publish(
      makeBundle(config({ okf: { enabled: true, maintain: { output_path: 'docs/okf' } } })),
      [contentDoc('pages/alpha')],
    );
    expect(result.warnings.some((w) => w.code === 'output_root_changed')).toBe(true);
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.bundle_generation).toBe(1); // reset, first publish of new root
    expect(manifest?.output_root).toBe(path.join(projectRoot, 'docs/okf'));
    expect(fs.existsSync(path.join(projectRoot, 'docs/okf/index.md'))).toBe(true);
    // The old bundle is orphaned, not deleted.
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(true);
  });
});

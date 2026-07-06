import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, OkfError, type OkfBundleDeps } from '@myco/okf/bundle.js';
import type { OkfBundleWriteInput } from '@myco/okf/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../helpers/db.js';

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

function seedSpore(id: string, content: string, extra: Record<string, unknown> = {}): void {
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
    ...extra,
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

function okfDir(): string {
  return path.join(projectRoot, 'okf');
}

describe('OkfBundle.maintain — happy path', () => {
  // Phase 2: renderDocuments is stubbed (Task 0.1); these exercise full projection.
  it.skip('produces a valid bundle tree with the expected shape', async () => {
    seedSpore('decision-1', 'We chose the async lock. It retries acquisition.');
    seedCanopyEntry(getDatabase(), {
      project_id: projectId,
      path: 'src/lock.ts',
      llm_description: 'Implements the async project lock.',
      llm_updated_at: 1_783_100_000,
      language: 'typescript',
    });

    const result = await makeBundle().maintain(baseInput());

    expect(result.unchanged).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(result.conceptCount).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(okfDir(), 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'log.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), '.myco-okf-maintain.json'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'guides/maintaining-this-bundle.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'canopy/files/src/lock.ts.md'))).toBe(true);
    // The whole tree passes myco_strict from disk.
    expect(makeBundle().validate().ok).toBe(true);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('re-run with unchanged inputs short-circuits and rewrites nothing', async () => {
    seedSpore('decision-1', 'A decision.');
    const bundle = makeBundle();
    await bundle.maintain(baseInput());
    const conceptPath = path.join(okfDir(), 'spores/decisions/decision-1.md');
    const mtimeBefore = fs.statSync(conceptPath).mtimeMs;

    const second = await makeBundle().maintain(baseInput());
    expect(second.unchanged).toBe(true);
    expect(fs.statSync(conceptPath).mtimeMs).toBe(mtimeBefore);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('dry-run writes no published bundle', async () => {
    seedSpore('decision-1', 'A decision.');
    const result = await makeBundle().maintain(baseInput({ dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(okfDir())).toBe(false);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('maintains with cortex.enabled=false (OKF does not depend on Cortex)', async () => {
    seedSpore('decision-1', 'A decision.');
    const result = await makeBundle(config({ cortex: { enabled: false } })).maintain(baseInput());
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(okfDir(), 'guides/maintaining-this-bundle.md'))).toBe(true);
  });
});

describe('OkfBundle.maintain — capability gate', () => {
  it('throws okf_disabled and writes nothing when the capability is off', async () => {
    seedSpore('decision-1', 'A decision.');
    const bundle = makeBundle(config({ okf: { enabled: false } }));
    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({ code: 'okf_disabled' });
    expect(fs.existsSync(okfDir())).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf'))).toBe(false);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); dry-run still reaches it.
  it.skip('allows dry-run while the capability is off', async () => {
    seedSpore('decision-1', 'A decision.');
    const result = await makeBundle(config({ okf: { enabled: false } })).maintain(baseInput({ dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(okfDir())).toBe(false);
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

describe('OkfBundle.maintain — publish eligibility', () => {
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('blocks first publish on an unacknowledged finding, then acknowledges and persists', async () => {
    seedSpore('decision-1', `A decision mentioning a key ${AWS_KEY} inline.`);
    const bundle = makeBundle();

    await expect(bundle.maintain(baseInput())).rejects.toMatchObject({ code: 'okf_publish_not_acknowledged' });
    expect(fs.existsSync(okfDir())).toBe(false);

    const ok = await makeBundle().maintain(baseInput({ acknowledgePublish: true }));
    expect(ok.unchanged).toBe(false);
    expect(fs.existsSync(path.join(okfDir(), 'spores/decisions/decision-1.md'))).toBe(true);

    // The acknowledgement persisted — a re-run with the SAME finding is not re-blocked.
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.acknowledged_findings.some((f) => f.code === 'likely_secret')).toBe(true);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('re-blocks when a NEW distinct finding appears', async () => {
    seedSpore('decision-1', `A decision with ${AWS_KEY}.`);
    await makeBundle().maintain(baseInput({ acknowledgePublish: true }));

    // Add a second spore carrying a different secret at a different path.
    seedSpore('decision-2', 'Another decision with /Users/chris/secret path.');
    await expect(makeBundle().maintain(baseInput())).rejects.toMatchObject({ code: 'okf_publish_not_acknowledged' });
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('never blocks a local-mode bundle', async () => {
    seedSpore('decision-1', `Local decision with ${AWS_KEY}.`);
    const result = await makeBundle().maintain(baseInput({ mode: 'local' }));
    expect(result.publishEligibility?.ok).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf/bundle/spores/decisions/decision-1.md'))).toBe(true);
  });
});

describe('OkfBundle.maintain — output root change', () => {
  // Phase 2: renderDocuments is stubbed (Task 0.1); this exercises full projection.
  it.skip('resets generation and warns when the output root changes', async () => {
    seedSpore('decision-1', 'A decision.');
    await makeBundle().maintain(baseInput());
    const genBefore = new ProjectVault(projectRoot).readOkfManifest()?.bundle_generation;
    expect(genBefore).toBe(1);

    // Point at a different published path.
    const result = await makeBundle(config({ okf: { enabled: true, maintain: { output_path: 'docs/okf' } } })).maintain(
      baseInput(),
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

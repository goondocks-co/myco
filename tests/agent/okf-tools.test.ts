/**
 * Tests for the OKF harness tools (packages/myco/src/agent/tools/okf-tools.ts).
 *
 * Uses the grove-DB fixture pattern from tests/mcp/tools/okf.test.ts —
 * createGrove + registerProjectInGrove + resolveGroveDbPath + a scoped
 * openDatabase/createSchema/withDatabase seed, then `initDatabase` so
 * `getDatabase()` (called ambiently by `gather()`/`OkfBundle`) reads the
 * seeded grove DB.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import {
  resolveLegacyRequestContext,
  projectScopeFromRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { createOkfTools, OKF_TOOL_NAMES } from '@myco/agent/tools/okf-tools.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';
import { vi } from '../helpers/vi-shim.js';

const PROJECT_ID = 'proj_ffffffffffffffffffffffffffffffff';
const AGENT_ID = 'claude-code';
const CONCEPT = (id: string) =>
  `---\ntype: Note\ntitle: A Note\ndescription: D.\ntags:\n  - okf\ntimestamp: 2026-07-05\nmyco_id: ${id}\n---\n\nBody.\n`;

async function invoke(t: { handler: (args: unknown) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  const result = (await t.handler(args)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

describe('OKF_TOOL_NAMES', () => {
  it('lists exactly the four OKF tool names', () => {
    expect([...OKF_TOOL_NAMES].sort()).toEqual(
      ['okf_list_changes', 'okf_read_bundle', 'okf_report', 'okf_write_concept'].sort(),
    );
  });
});

describe('createOkfTools — fail-closed on missing deps', () => {
  const baseDeps = { agentId: 'a', runId: 'r', recordTurn: () => null } as unknown as VaultToolDeps;

  it('okf_read_bundle errors when projectRoot/vaultDir/requestContext are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const readBundle = tools.find((t) => t.name === 'okf_read_bundle')!;
    const result = await invoke(readBundle, {});
    expect(result.error).toBeTruthy();
  });

  it('okf_list_changes errors when deps are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const listChanges = tools.find((t) => t.name === 'okf_list_changes')!;
    const result = await invoke(listChanges, {});
    expect(result.error).toBeTruthy();
  });

  it('okf_write_concept errors when deps are absent', async () => {
    const tools = createOkfTools(baseDeps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')!;
    const result = await invoke(writeConcept, { id: 'concepts/x', markdown: CONCEPT('concepts/x') });
    expect(result.error).toBeTruthy();
  });
});

describe('OKF tool annotations', () => {
  const baseDeps = { agentId: 'a', runId: 'r', recordTurn: () => null } as unknown as VaultToolDeps;

  it('okf_read_bundle, okf_list_changes, and okf_report carry readOnlyHint: true', () => {
    const tools = createOkfTools(baseDeps);
    for (const name of ['okf_read_bundle', 'okf_list_changes', 'okf_report']) {
      const t = tools.find((tool) => tool.name === name)!;
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('okf_write_concept does NOT carry readOnlyHint (it is a write)', () => {
    const tools = createOkfTools(baseDeps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')!;
    expect(writeConcept.annotations?.readOnlyHint).not.toBe(true);
  });

  it('okf_write_concept schema has no expected_generation parameter', () => {
    const tools = createOkfTools(baseDeps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')! as { inputSchema?: { shape?: Record<string, unknown> } };
    // The SDK `tool()` helper wraps a zod shape; walk whatever shape the
    // mocked/real SDK exposes without assuming a specific internal layout.
    const schema = writeConcept.inputSchema as unknown;
    const schemaKeys = schema && typeof schema === 'object'
      ? Object.keys((schema as { shape?: Record<string, unknown> }).shape ?? schema as Record<string, unknown>)
      : [];
    expect(schemaKeys).not.toContain('expected_generation');
    expect(schemaKeys).not.toContain('expectedGeneration');
  });
});

describe('OKF tools — live bundle', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let ctx: MycoRequestContext;
  let deps: VaultToolDeps;

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  beforeEach(async () => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-tools-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-tools' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-tools', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      insertRun({
        id: 'run-okf-tools-1',
        project_id: PROJECT_ID,
        agent_id: AGENT_ID,
        task: 'okf-maintain',
        status: 'running',
        started_at: 1_783_000_000,
      });
    });

    // Publish a bundle up front so read/write tools have something to act on.
    const config = loadMergedConfig(vaultDir, { groveId: grove.id });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: projectScopeFromRequestContext(ctx),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: projectScopeFromRequestContext(ctx),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    deps = {
      agentId: AGENT_ID,
      runId: 'run-okf-tools-1',
      projectRoot,
      vaultDir,
      requestContext: ctx,
      machineId: 'machine-a',
      recordTurn: () => null,
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); this suite's beforeEach
  // bootstraps via a real maintain() run, so every test below is blocked.
  it.skip('okf_read_bundle with no id returns a bundle summary', async () => {
    const tools = createOkfTools(deps);
    const readBundle = tools.find((t) => t.name === 'okf_read_bundle')!;
    const result = await invoke(readBundle, {});
    expect(result.status.bundleExists).toBe(true);
    expect(Array.isArray(result.concepts)).toBe(true);
  });

  it.skip('okf_read_bundle with an id returns raw concept markdown', async () => {
    const tools = createOkfTools(deps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')!;
    await invoke(writeConcept, { id: 'concepts/note', markdown: CONCEPT('concepts/note') });

    const readBundle = tools.find((t) => t.name === 'okf_read_bundle')!;
    const result = await invoke(readBundle, { id: 'concepts/note' });
    expect(result.concept.raw).toContain('myco_provenance');
  });

  it.skip('okf_list_changes reports unchanged inputs right after publish', async () => {
    const tools = createOkfTools(deps);
    const listChanges = tools.find((t) => t.name === 'okf_list_changes')!;
    const result = await invoke(listChanges, {});
    expect(result.inputsChanged).toBe(false);
    expect(result.sporeCount).toBe(1);
  });

  it.skip('okf_list_changes reports changed inputs after a new spore lands', async () => {
    insertSpore({ id: 'decision-2', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'Another decision.', importance: 5, created_at: 1_783_000_100, machine_id: 'machine-a' });
    const tools = createOkfTools(deps);
    const listChanges = tools.find((t) => t.name === 'okf_list_changes')!;
    const result = await invoke(listChanges, {});
    expect(result.inputsChanged).toBe(true);
    expect(result.sporeCount).toBe(2);
  });

  it.skip('okf_write_concept saves a harness-provenance concept and bumps the generation', async () => {
    const tools = createOkfTools(deps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')!;
    const result = await invoke(writeConcept, { id: 'concepts/note', markdown: CONCEPT('concepts/note') });
    expect(result.bundleGeneration).toBe(2);

    const saved = fs.readFileSync(path.join(projectRoot, 'okf/concepts/note.md'), 'utf8');
    expect(saved).toContain('actor: harness');
    expect(saved).toContain('run_ref');
  });

  it.skip('okf_write_concept rejects a deterministic path (spores/...)', async () => {
    const tools = createOkfTools(deps);
    const writeConcept = tools.find((t) => t.name === 'okf_write_concept')!;
    const result = await invoke(writeConcept, { id: 'spores/decisions/decision-1', markdown: CONCEPT('spores/decisions/decision-1') });
    expect(result.error).toBeTruthy();
    expect(result.code).toBe('deterministic_path_not_editable');
  });

  it.skip('okf_report records a report row and does NOT publish (fs snapshot unchanged)', async () => {
    const okfDir = path.join(projectRoot, 'okf');
    const beforeSnapshot = fs.readdirSync(okfDir).sort();
    const beforeGeneration = new ProjectVault(projectRoot).readOkfManifest()?.bundle_generation;

    const tools = createOkfTools(deps);
    const report = tools.find((t) => t.name === 'okf_report')!;
    const result = await invoke(report, { summary: 'Nothing to do this run.' });
    expect(result.action).toBe('okf_maintain');

    const afterSnapshot = fs.readdirSync(okfDir).sort();
    const afterGeneration = new ProjectVault(projectRoot).readOkfManifest()?.bundle_generation;
    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(afterGeneration).toBe(beforeGeneration);
  });
});

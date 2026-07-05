import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
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
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { handleMycoOkf } from '@myco/tools/okf.js';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';
import { vi } from '../../helpers/vi-shim.js';

const PROJECT_ID = 'proj_dddddddddddddddddddddddddddddddd';
const AGENT_ID = 'claude-code';
const CONCEPT = (id: string) =>
  `---\ntype: Note\ntitle: A Note\ndescription: D.\ntags:\n  - okf\ntimestamp: 2026-07-05\nmyco_id: ${id}\n---\n\nBody.\n`;

describe('myco_okf tool definition', () => {
  it('exposes ONLY editorial ops — no maintain/outputRoot/acknowledge (schema is the authorization boundary)', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'myco_okf');
    expect(def).toBeDefined();
    const props = Object.keys((def!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).not.toContain('maintain');
    expect(props).not.toContain('outputRoot');
    expect(props).not.toContain('acknowledgePublish');
    expect(props).not.toContain('acknowledge_publish');
    const ops = ((def!.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum);
    expect(ops).toEqual(['status', 'validate', 'list', 'get', 'save_concept', 'supersede_concept']);
  });
});

describe('handleMycoOkf', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let ctx: MycoRequestContext;
  const client = {} as never;

  beforeEach(async () => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-mcp-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-mcp' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-mcp', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    // Seed the grove DB, then open it as the process singleton so both the
    // pre-maintain and the tool handler read the same store.
    const seedDb = openDatabase(groveDbPath);
    createSchema(seedDb);
    withDatabase(seedDb, () => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
    });
    seedDb.close();
    initDatabase(groveDbPath);

    // Publish a bundle up front (maintain is not on the MCP surface).
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('op status returns bundle metadata (read-only)', async () => {
    const result = (await handleMycoOkf({ op: 'status' }, client, ctx)) as { bundleExists: boolean; bundleGeneration: number };
    expect(result.bundleExists).toBe(true);
    expect(result.bundleGeneration).toBe(1);
  });

  it('op list and validate are read-only', async () => {
    const list = (await handleMycoOkf({ op: 'list' }, client, ctx)) as { concepts: unknown[] };
    expect(Array.isArray(list.concepts)).toBe(true);
    const validation = (await handleMycoOkf({ op: 'validate' }, client, ctx)) as { ok: boolean };
    expect(validation.ok).toBe(true);
  });

  it('op save_concept writes an editorial concept stamped with actor: symbiont', async () => {
    const result = (await handleMycoOkf(
      { op: 'save_concept', concept_id: 'concepts/note', markdown: CONCEPT('concepts/note') },
      client,
      ctx,
    )) as { bundleGeneration: number };
    expect(result.bundleGeneration).toBe(2);
    const saved = fs.readFileSync(path.join(projectRoot, 'okf/concepts/note.md'), 'utf8');
    expect(saved).toContain('myco_provenance');
    expect(saved).toContain('actor: symbiont');
  });

  it('rejects saving to a deterministic projection path', async () => {
    const result = (await handleMycoOkf(
      { op: 'save_concept', concept_id: 'spores/decisions/decision-1', markdown: CONCEPT('spores/decisions/decision-1') },
      client,
      ctx,
    )) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('deterministic_path_not_editable');
  });

  it('surfaces a generation conflict on a stale expected_generation', async () => {
    const result = (await handleMycoOkf(
      { op: 'save_concept', concept_id: 'concepts/note', markdown: CONCEPT('concepts/note'), expected_generation: 0 },
      client,
      ctx,
    )) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('okf_generation_conflict');
  });

  it('fails without a caller request context', async () => {
    const result = (await handleMycoOkf({ op: 'status' }, client, undefined)) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('request context');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import {
  resolveLegacyRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { handleMycoOkf } from '@myco/tools/okf.js';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';
import { vi } from '../../helpers/vi-shim.js';

const PROJECT_ID = 'proj_dddddddddddddddddddddddddddddddd';

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

// `list`/`get` (bundle.listPages()/getPage()) walk the published tree
// directly — no manifest/marker dependency — so they can be exercised by
// seeding the tree with a raw file write.
describe('handleMycoOkf list/get — document model', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let ctx: MycoRequestContext;
  const client = {} as never;

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-mcp-pages-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-mcp-pages' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-mcp-pages', projectRoot, bindingId: 'g' }, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    fs.mkdirSync(path.join(projectRoot, 'okf/notes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'okf/notes/example.md'),
      '---\ntype: Note\ntitle: Example\ndescription: D.\ntimestamp: 2026-07-05\n---\n\nBody text.\n',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('op list returns OKF-shaped pages, no Myco fields', async () => {
    const result = (await handleMycoOkf({ op: 'list' }, client, ctx)) as { pages: Array<Record<string, unknown>> };
    expect(result.pages).toEqual([
      { path: 'notes/example.md', type: 'Note', title: 'Example', description: 'D.', timestamp: '2026-07-05' },
    ]);
    expect(result.pages[0]).not.toHaveProperty('myco_source_kind');
  });

  it('op get returns the parsed page shape with a rendered-markdown body', async () => {
    const result = (await handleMycoOkf({ op: 'get', id: 'notes/example' }, client, ctx)) as { page: Record<string, unknown> };
    expect(result.page).toEqual({
      path: 'notes/example.md',
      type: 'Note',
      title: 'Example',
      description: 'D.',
      timestamp: '2026-07-05',
      body: 'Body text.',
    });
  });

  it('op get returns page: null for a missing page', async () => {
    const result = (await handleMycoOkf({ op: 'get', id: 'notes/missing' }, client, ctx)) as { page: unknown };
    expect(result.page).toBeNull();
  });
});

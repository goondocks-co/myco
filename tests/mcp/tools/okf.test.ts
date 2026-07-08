import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
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

  beforeEach(async () => {
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
    const groveDbPath = resolveGroveDbPath(grove.id, home);
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, () => {});
    db.close();
    initDatabase(groveDbPath);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    // Pages are DB rows — seed through the tool's own editorial write path.
    await handleMycoOkf({
      op: 'save_concept',
      concept_id: 'notes/example',
      markdown: '---\ntype: Note\ntitle: Example\ndescription: D.\n---\n\nBody text.\n',
    }, client, ctx);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('op list returns OKF-shaped pages, no Myco fields', async () => {
    const result = (await handleMycoOkf({ op: 'list' }, client, ctx)) as { pages: Array<Record<string, unknown>> };
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ path: 'notes/example.md', type: 'Note', title: 'Example', description: 'D.' });
    expect(result.pages[0]).not.toHaveProperty('myco_source_kind');
    expect(result.pages[0]).not.toHaveProperty('machine_id');
  });

  it('op get returns the page content with frontmatter fields and body', async () => {
    const result = (await handleMycoOkf({ op: 'get', id: 'notes/example' }, client, ctx)) as { page: { path: string; frontmatter: Record<string, unknown>; body: string } };
    expect(result.page.path).toBe('notes/example.md');
    expect(result.page.frontmatter).toMatchObject({ type: 'Note', title: 'Example', description: 'D.' });
    expect(result.page.body).toBe('Body text.');
  });

  it('op get returns page: null for a missing page', async () => {
    const result = (await handleMycoOkf({ op: 'get', id: 'notes/missing' }, client, ctx)) as { page: unknown };
    expect(result.page).toBeNull();
  });
});

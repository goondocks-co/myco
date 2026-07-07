import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOkfCommand, run } from '@myco/cli/okf.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { openDatabase, withDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { REQUEST_CONTEXT_ENV } from '@myco/grove/request-context.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { vi } from '../helpers/vi-shim.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT_ID = 'claude-code';

// -------------------------- parseOkfCommand (pure) --------------------------

describe('parseOkfCommand', () => {
  it('parses concept save/supersede', () => {
    expect(parseOkfCommand(['concept', 'save', '--id', 'concepts/x', '--input', '@a.md']).ok).toBe(true);
    expect(parseOkfCommand(['concept', 'save', '--id', 'concepts/x']).ok).toBe(false);
    const sup = parseOkfCommand(['concept', 'supersede', 'concepts/a', 'concepts/b', '--reason', 'r']);
    expect(sup.ok).toBe(true);
  });

  it('rejects a bare concept list/get — retired in favor of `page list`/`page get`', () => {
    expect(parseOkfCommand(['concept', 'list']).ok).toBe(false);
    expect(parseOkfCommand(['concept', 'get', 'concepts/x']).ok).toBe(false);
  });

  it('parses page list/get', () => {
    expect(parseOkfCommand(['page', 'list']).ok).toBe(true);
    const get = parseOkfCommand(['page', 'get', 'notes/my-note']);
    expect(get.ok).toBe(true);
    if (get.ok && get.cmd.kind === 'page-get') {
      expect(get.cmd.path).toBe('notes/my-note');
    }
  });

  it('rejects a bare page get with no path', () => {
    expect(parseOkfCommand(['page', 'get']).ok).toBe(false);
  });

  it('supersede accepts a --reason string equal to a concept id (index-based flag consumption)', () => {
    const r = parseOkfCommand(['concept', 'supersede', 'concepts/a', 'concepts/b', '--reason', 'concepts/b']);
    expect(r.ok).toBe(true);
    if (r.ok && r.cmd.kind === 'concept-supersede') {
      expect(r.cmd.oldId).toBe('concepts/a');
      expect(r.cmd.newId).toBe('concepts/b');
      expect(r.cmd.reason).toBe('concepts/b');
    }
  });

  it('rejects an unknown subcommand', () => {
    expect(parseOkfCommand(['frobnicate']).ok).toBe(false);
  });
});

// -------------------------- run (integration) --------------------------

describe('myco okf CLI', () => {
  let rootDir: string;
  let vaultDir: string;
  let groveDbPath: string;
  let written: string[];
  let originalLog: typeof console.log;

  function writeConfig(okfEnabled: boolean): void {
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      `version: 3\nokf:\n  enabled: ${okfEnabled}\ncortex:\n  enabled: false\n`,
    );
  }

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
  }

  function lastJson(): Record<string, unknown> {
    return JSON.parse(written.join('')) as Record<string, unknown>;
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-cli-')));
    const home = path.join(rootDir, 'home');
    const projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-cli-test' },
      grove: { binding_id: 'gbind-cli', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(
      grove.id,
      { projectId: PROJECT_ID, projectName: 'okf-cli-test', projectRoot, bindingId: 'gbind-cli' },
      home,
    );
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, PROJECT_ID);
    vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
    vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');
    groveDbPath = resolveGroveDbPath(grove.id, home);

    written = [];
    originalLog = console.log;
    console.log = ((...parts: unknown[]) => {
      written.push(parts.map((p) => String(p)).join(' '));
    }) as typeof console.log;
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    vi.unstubAllEnvs();
    closeDatabase();
    process.exitCode = 0;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const projectRoot = () => path.dirname(vaultDir);

  it('exits 1 on a parse error with invalid_arguments', async () => {
    writeConfig(true);
    seedGroveDb(() => registerAgent({ id: AGENT_ID, name: 'Agent', created_at: 1_783_000_000 }));
    await run(['bogus-subcommand'], vaultDir);
    expect(process.exitCode).toBe(1);
    expect((lastJson().error as { code: string }).code).toBe('invalid_arguments');
  });

  it('exits 1 (user error, not 2) when the concept --input file is unreadable', async () => {
    // The @file read fails in dispatch before the capability is reached, so no
    // published bundle is needed to exercise the user-error path.
    writeConfig(true);
    seedGroveDb(() => registerAgent({ id: AGENT_ID, name: 'Agent', created_at: 1_783_000_000 }));
    await run(['concept', 'save', '--id', 'concepts/x', '--input', '@/nonexistent/file.md'], vaultDir);
    expect(process.exitCode).toBe(1);
    expect((lastJson().error as { code: string }).code).toBe('invalid_input_file');
  });

  // listPages()/getPage() walk the published tree directly (no manifest/
  // marker dependency) — seed it with a raw file write.
  it('page list returns published pages with OKF fields, no Myco fields', async () => {
    writeConfig(true);
    seedGroveDb(() => registerAgent({ id: AGENT_ID, name: 'Agent', created_at: 1_783_000_000 }));
    fs.mkdirSync(path.join(projectRoot(), 'okf', 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot(), 'okf/notes/example.md'),
      '---\ntype: Note\ntitle: Example\ndescription: D.\ntimestamp: 2026-07-05\n---\n\nBody.\n',
    );
    await run(['page', 'list'], vaultDir);
    expect(process.exitCode).toBe(0);
    const pages = lastJson().pages as Array<Record<string, unknown>>;
    expect(pages).toEqual([
      { path: 'notes/example.md', type: 'Note', title: 'Example', description: 'D.', timestamp: '2026-07-05' },
    ]);
    expect(pages[0]).not.toHaveProperty('myco_source_kind');
  });

  it('page get returns the parsed page shape with a rendered-markdown body', async () => {
    writeConfig(true);
    seedGroveDb(() => registerAgent({ id: AGENT_ID, name: 'Agent', created_at: 1_783_000_000 }));
    fs.mkdirSync(path.join(projectRoot(), 'okf', 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot(), 'okf/notes/example.md'),
      '---\ntype: Note\ntitle: Example\ndescription: D.\ntimestamp: 2026-07-05\n---\n\nBody text.\n',
    );
    await run(['page', 'get', 'notes/example'], vaultDir);
    expect(process.exitCode).toBe(0);
    expect(lastJson().page).toEqual({
      path: 'notes/example.md',
      type: 'Note',
      title: 'Example',
      description: 'D.',
      timestamp: '2026-07-05',
      body: 'Body text.',
    });
  });

  it('page get returns page: null for a missing page', async () => {
    writeConfig(true);
    seedGroveDb(() => registerAgent({ id: AGENT_ID, name: 'Agent', created_at: 1_783_000_000 }));
    await run(['page', 'get', 'notes/missing'], vaultDir);
    expect(process.exitCode).toBe(0);
    expect(lastJson().page).toBeNull();
  });
});

// -------------------------- structural funnel --------------------------

describe('okf CLI is a thin funnel', () => {
  it('performs no direct filesystem writes (all writes go through OkfBundle)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../packages/myco/src/cli/okf.ts'), 'utf8');
    expect(src).not.toMatch(/fs\.writeFileSync/);
    expect(src).not.toMatch(/fs\.mkdirSync/);
    expect(src).not.toMatch(/fs\.rmSync/);
    // The only fs use is reading the concept @file.
    expect(src).toMatch(/fs\.readFileSync/);
  });
});

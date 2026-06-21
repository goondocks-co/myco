import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  isProjectPaused,
  listGroves,
  listRegisteredProjects,
  loadGroveRecord,
  pauseProject,
  registerProjectInGrove,
  setDefaultGrove,
} from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { createProjectId } from '@myco/grove/ids.js';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/grove.js';

function listGrovesByName(name: string): ReturnType<typeof listGroves>[number] | undefined {
  return listGroves(home).find((g) => g.name === name);
}

function ensureGroveDb(groveId: string, mycoHome: string): void {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('claude-code', 'Claude Code', 'built-in', 1, 100);
  } finally {
    db.close();
  }
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-cli-'));
  process.env.MYCO_HOME = home;
  clearGroveRegistryCaches();
});

afterEach(() => {
  delete process.env.MYCO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

describe('myco grove CLI', () => {
  it('creates, lists, and selects Groves', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['create', 'Work']);
    await run(['list']);
    await run(['use', 'work']);

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Created Grove Work');
    expect(output).toContain('Work (work)');
    expect(output).toContain('Default Grove: Work');

    log.mockRestore();
  });

  it('migrates projects into the default Grove when --grove is omitted', async () => {
    const projectRoot = path.join(home, 'project');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const db = openDatabase(path.join(vaultDir, 'myco.db'));
    try {
      createSchema(db);
    } finally {
      db.close();
    }

    createGrove('Dogfood', home);
    const defaultGrove = createGrove('Default Projects', home);
    setDefaultGrove(defaultGrove.id, home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['migrate-project', '--project', projectRoot, '--dry-run', '--json']);

    const parsed = JSON.parse(log.mock.calls.at(-1)?.[0] as string) as { grove: { id: string }; dry_run: boolean };
    expect(parsed.grove.id).toBe(defaultGrove.id);
    expect(parsed.dry_run).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);

    log.mockRestore();
  });

  it('renames a Grove by ref', async () => {
    const grove = createGrove('Original Grove', home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['rename', grove.slug, 'Shiny New']);

    const updated = loadGroveRecord(grove.id, home);
    expect(updated?.name).toBe('Shiny New');
    expect(updated?.slug).toBe('shiny-new');

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Renamed: Shiny New (shiny-new)');

    log.mockRestore();
  });

  it('deletes an empty Grove', async () => {
    const grove = createGrove('To Delete', home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['delete', grove.slug]);

    expect(loadGroveRecord(grove.id, home)).toBeNull();
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted Grove To Delete (to-delete)');

    log.mockRestore();
  });

  it('refuses to delete a non-empty Grove without --force', async () => {
    const grove = createGrove('Busy', home);
    const projectRoot = path.join(home, 'project-busy');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId: createProjectId(),
      projectName: 'Demo',
      projectRoot,
    }, home);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(run(['delete', grove.slug])).rejects.toThrow('exit:1');

    expect(loadGroveRecord(grove.id, home)).not.toBeNull();
    const errOut = errSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(errOut).toMatch(/bound project/);
    expect(errOut).toContain('Use --force');

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('deletes a non-empty Grove with --force', async () => {
    const grove = createGrove('Force Me', home);
    const projectRoot = path.join(home, 'project-force');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId: createProjectId(),
      projectName: 'Demo',
      projectRoot,
    }, home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['delete', grove.slug, '--force']);

    expect(loadGroveRecord(grove.id, home)).toBeNull();
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted Grove Force Me (force-me)');

    log.mockRestore();
  });

  it('moves a project to another Grove and prints the snapshot path', async () => {
    const source = createGrove('Src', home);
    const target = createGrove('Tgt', home);
    ensureGroveDb(source.id, home);
    ensureGroveDb(target.id, home);

    const projectRoot = path.join(home, 'project-move');
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    const projectId = createProjectId();
    registerProjectInGrove(source.id, {
      projectId,
      projectName: 'Mover',
      projectRoot,
    }, home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['move', projectId, '--grove', target.slug]);

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Moving project Mover');
    expect(output).toMatch(/from:\s+Src \(src\)/);
    expect(output).toMatch(/to:\s+Tgt \(tgt\)/);
    expect(output).toContain('Move complete. Snapshot:');

    expect(listRegisteredProjects(source.id, home).map((p) => p.project_id))
      .not.toContain(projectId);
    expect(listRegisteredProjects(target.id, home).map((p) => p.project_id))
      .toContain(projectId);

    log.mockRestore();
  });

  it('grove create always stamps served_by = service (variant collapse)', async () => {
    // Ownership is the home now, not the daemon variant: every Grove a
    // daemon creates lands in its own MYCO_HOME and is stamped 'service'.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['create', 'ProdOne']);
    const prod = listGrovesByName('ProdOne');
    expect(prod?.served_by).toBe('service');
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('served_by service');
    log.mockRestore();
  });

  it('grove list includes served_by per row', async () => {
    createGrove('Alpha', home, { servedBy: 'service' });
    createGrove('Beta', home, { servedBy: 'service-dev' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['list']);
    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/Alpha \(alpha\).*service\b/);
    expect(out).toMatch(/Beta \(beta\).*service-dev/);
    log.mockRestore();
  });

  it('grove force-resume-project clears a stuck per-project pause', async () => {
    const grove = createGrove('Stuck', home);
    ensureGroveDb(grove.id, home);
    const projectRoot = path.join(home, 'project-stuck');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectId = createProjectId();
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Stuck',
      projectRoot,
    }, home);
    pauseProject(grove.id, projectId, 'grove-move', 'op-stuck-1', home);
    expect(isProjectPaused(projectId, home).paused).toBe(true);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['force-resume-project', projectId, '--force']);
    expect(isProjectPaused(projectId, home).paused).toBe(false);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Force-resumed project Stuck');
    log.mockRestore();
  });

  it('grove force-resume-project refuses without --force', async () => {
    const grove = createGrove('NeedsForce', home);
    const projectRoot = path.join(home, 'project-needs-force');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectId = createProjectId();
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'NeedsForce',
      projectRoot,
    }, home);

    await expect(run(['force-resume-project', projectId])).rejects.toThrow(/--force/);
  });

  it('rejects move when project is already in the target Grove', async () => {
    const grove = createGrove('Solo', home);
    ensureGroveDb(grove.id, home);
    const projectRoot = path.join(home, 'project-solo');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectId = createProjectId();
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Solo',
      projectRoot,
    }, home);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(run(['move', projectId, '--grove', grove.slug])).rejects.toThrow('exit:1');
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/already in Grove Solo/);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

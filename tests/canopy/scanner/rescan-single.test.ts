import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { rescanSingle } from '@myco/canopy/scanner/rescan-single';
import { handleCanopyToolUse } from '@myco/canopy/scanner/handle-tool-use';
import type { DaemonLogger } from '@myco/daemon/logger';

const PROJECT_ID_PREFIX = 'p';

let tmp: string;
let projectRoot: string;
let projectId: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rescan-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  projectId = projectRoot;
  initDatabase(path.join(tmp, 'myco.db'));
  createSchema(getDatabase());
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function rowExists(rel: string): boolean {
  return Boolean(getDatabase().prepare(
    'SELECT 1 FROM canopy_entries WHERE project_id = ? AND path = ?',
  ).get(projectId, rel));
}

describe('rescanSingle', () => {
  it('upserts the row for an existing file', () => {
    write('src/a.ts', 'export const x = 1;\n');
    const r = rescanSingle({
      db: getDatabase(),
      projectId,
      machineId: 'local',
      projectRoot,
      filePath: 'src/a.ts',
    });
    expect(r).toEqual({ ok: true, action: 'upserted', relPath: 'src/a.ts' });
    expect(rowExists('src/a.ts')).toBe(true);
  });

  it('deletes the row when the file is gone', () => {
    write('src/a.ts', 'export const x = 1;\n');
    rescanSingle({ db: getDatabase(), projectId, machineId: 'local', projectRoot, filePath: 'src/a.ts' });
    fs.unlinkSync(path.join(projectRoot, 'src/a.ts'));
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot, filePath: 'src/a.ts',
    });
    expect(r).toEqual({ ok: true, action: 'deleted', relPath: 'src/a.ts' });
    expect(rowExists('src/a.ts')).toBe(false);
  });

  it('rejects paths outside the project root', () => {
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot,
      filePath: path.join(tmp, 'outside.ts'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('outside_project');
  });

  it('accepts absolute paths inside the project root', () => {
    write('src/b.ts', 'export const y = 1;\n');
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot,
      filePath: path.join(projectRoot, 'src/b.ts'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relPath).toBe('src/b.ts');
  });

  it('refuses to upsert a row for a managed-segment path (e.g. .myco/)', () => {
    write('.myco/notes.md', 'shhh\n');
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot,
      filePath: '.myco/notes.md',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('excluded');
    expect(rowExists('.myco/notes.md')).toBe(false);
  });

  it('refuses to upsert a row for a gitignored path', () => {
    write('.gitignore', 'private/\n');
    write('private/secret.ts', 'shhh\n');
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot,
      filePath: 'private/secret.ts',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('excluded');
    expect(rowExists('private/secret.ts')).toBe(false);
  });

  it('tombstones a previously-indexed row when a Write turns the file binary', () => {
    // First scan: plain text → row lands in canopy_entries.
    write('src/notes.md', 'project notes\n');
    rescanSingle({ db: getDatabase(), projectId, machineId: 'local', projectRoot, filePath: 'src/notes.md' });
    expect(rowExists('src/notes.md')).toBe(true);

    // Now overwrite with content containing a NUL byte. The file still
    // exists, so the existsSync gate passes; scanFile then rejects with
    // reason='binary'. Without inline cleanup the row would linger and
    // /canopy/inject would keep handing the agent stale anatomy until the
    // next periodic full/delta scan.
    fs.writeFileSync(path.join(projectRoot, 'src/notes.md'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const r = rescanSingle({ db: getDatabase(), projectId, machineId: 'local', projectRoot, filePath: 'src/notes.md' });
    expect(r).toEqual({ ok: true, action: 'deleted', relPath: 'src/notes.md' });
    expect(rowExists('src/notes.md')).toBe(false);
  });

  it('tombstones a previously-indexed row when a Write pushes the file past maxBytes', () => {
    write('src/big.ts', 'export const x = 1;\n');
    rescanSingle({ db: getDatabase(), projectId, machineId: 'local', projectRoot, filePath: 'src/big.ts' });
    expect(rowExists('src/big.ts')).toBe(true);

    // Bloat past a tight maxBytes cap to trip the too_large branch.
    fs.writeFileSync(path.join(projectRoot, 'src/big.ts'), 'x'.repeat(2048));
    const r = rescanSingle({
      db: getDatabase(), projectId, machineId: 'local', projectRoot,
      filePath: 'src/big.ts', maxBytes: 1024,
    });
    expect(r).toEqual({ ok: true, action: 'deleted', relPath: 'src/big.ts' });
    expect(rowExists('src/big.ts')).toBe(false);
  });
});

describe('handleCanopyToolUse', () => {
  function makeLogger() {
    const calls: Array<{ level: string; kind: string }> = [];
    const logger = {
      info: (kind: string) => calls.push({ level: 'info', kind }),
      warn: (kind: string) => calls.push({ level: 'warn', kind }),
      error: (kind: string) => calls.push({ level: 'error', kind }),
      debug: (kind: string) => calls.push({ level: 'debug', kind }),
    } as unknown as DaemonLogger;
    return { logger, calls };
  }

  it('triggers a rescan for Write tool events (claude-code manifest vocabulary)', () => {
    write('src/a.ts', 'export const x = 1;\n');
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'claude-code',
      toolName: 'Write',
      toolInput: { file_path: path.join(projectRoot, 'src/a.ts') },
    });
    expect(rowExists('src/a.ts')).toBe(true);
    expect(calls.some((c) => c.kind === 'canopy.rescan')).toBe(true);
  });

  it('triggers a rescan for pi lowercase edit via the pi manifest', () => {
    write('src/pi-edit.ts', 'export const pi = 3;\n');
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'pi',
      toolName: 'edit',
      toolInput: { path: path.join(projectRoot, 'src/pi-edit.ts') },
    });
    expect(rowExists('src/pi-edit.ts')).toBe(true);
    expect(calls.some((c) => c.kind === 'canopy.rescan')).toBe(true);
  });

  it('triggers a rescan for codex apply_patch via patch-envelope extraction', () => {
    write('src/patched.ts', 'export const patched = true;\n');
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'codex',
      toolName: 'apply_patch',
      toolInput: {
        command: `*** Begin Patch\n*** Update File: ${path.join(projectRoot, 'src/patched.ts')}\n+export const patched = true;\n*** End Patch`,
      },
    });
    expect(rowExists('src/patched.ts')).toBe(true);
    expect(calls.some((c) => c.kind === 'canopy.rescan')).toBe(true);
  });

  it('never rescans on read tools — including path-bearing ones', () => {
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'claude-code',
      toolName: 'Read',
      toolInput: { file_path: 'src/a.ts' },
    });
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'pi',
      toolName: 'read',
      toolInput: { path: 'src/a.ts' },
    });
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'pi',
      toolName: 'bash',
      toolInput: { command: 'cat src/a.ts' },
    });
    expect(calls.length).toBe(0);
  });

  it('ignores tools from an unknown agent manifest', () => {
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      agent: 'no-such-agent',
      toolName: 'Write',
      toolInput: { file_path: 'src/a.ts' },
    });
    expect(calls.length).toBe(0);
  });
});

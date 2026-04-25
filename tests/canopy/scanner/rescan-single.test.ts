import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { rescanSingle } from '@myco/canopy/scanner/rescan-single';
import { handleCanopyToolUse, FILE_MUTATING_TOOLS_LIST } from '@myco/canopy/scanner/handle-tool-use';
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

  it('triggers a rescan for Write tool events', () => {
    write('src/a.ts', 'export const x = 1;\n');
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      toolName: 'Write',
      toolInput: { file_path: path.join(projectRoot, 'src/a.ts') },
    });
    expect(rowExists('src/a.ts')).toBe(true);
    expect(calls.some((c) => c.kind === 'canopy.rescan')).toBe(true);
  });

  it('ignores tool events outside the file-mutating set', () => {
    const { logger, calls } = makeLogger();
    handleCanopyToolUse({
      db: getDatabase(),
      logger, machineId: 'local', projectRoot, projectId,
      toolName: 'Read',
      toolInput: { file_path: 'src/a.ts' },
    });
    expect(calls.length).toBe(0);
  });

  it('exposes the trigger list', () => {
    expect(FILE_MUTATING_TOOLS_LIST).toContain('Write');
    expect(FILE_MUTATING_TOOLS_LIST).toContain('Edit');
  });
});

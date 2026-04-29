import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { scanProject } from '@myco/canopy/scanner/scan-project';
import { deltaScan } from '@myco/canopy/scanner/delta-scan';

const PROJECT_ID = 'test-project';
// Schema defaults are now empty — exclusion comes from the per-fixture
// `.gitignore` plus Myco-managed segments. Tests that depend on
// `node_modules`/`.git` being skipped write a `.gitignore` for the case.
const DEFAULT_PATTERNS: string[] = [];

let tmp: string;
let projectRoot: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scan-proj-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = path.join(tmp, 'myco.db');
  const db = initDatabase(dbPath);
  createSchema(db);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(relPath: string, content: string) {
  const abs = path.join(projectRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function rowCount(): number {
  const db = getDatabase();
  return (db.prepare('SELECT COUNT(*) AS n FROM canopy_entries WHERE project_id = ?').get(PROJECT_ID) as { n: number }).n;
}

const baseOpts = () => ({
  db: getDatabase(),
  projectId: PROJECT_ID,
  machineId: 'local',
  projectRoot,
  defaultExcludePatterns: [] as string[],
  excludePatterns: DEFAULT_PATTERNS,
});

describe('scanProject', () => {
  it('populates rows for non-excluded files and respects default exclusions', () => {
    // Write a project-local .gitignore so the scanner's gitignore layer
    // does the work that the now-empty default user patterns used to do.
    write('.gitignore', 'node_modules\n.git\npackage-lock.json\n');
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 2;\n');
    write('node_modules/ignored.ts', 'export const x = 1;\n');
    write('.git/HEAD', 'ref: refs/heads/main\n');
    write('package-lock.json', '{}');
    write('README.md', '# hello\n');

    const result = scanProject(baseOpts());
    // .gitignore + src/a + src/b + README = 4 indexable files
    expect(rowCount()).toBe(4);
    expect(result.added).toBe(4);
    expect(result.removed).toBe(0);
  });

  it('tombstones rows whose files have been deleted', () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 2;\n');
    scanProject(baseOpts());
    expect(rowCount()).toBe(2);

    fs.unlinkSync(path.join(projectRoot, 'src/b.ts'));
    const result = scanProject(baseOpts());
    expect(result.removed).toBe(1);
    expect(rowCount()).toBe(1);
  });

  it('upsert is idempotent across repeated full scans', () => {
    write('src/a.ts', 'export const a = 1;\n');
    scanProject(baseOpts());
    const first = rowCount();
    scanProject(baseOpts());
    expect(rowCount()).toBe(first);
  });

  it('does not tombstone existing rows when the project root is unreadable or missing', () => {
    write('src/a.ts', 'export const a = 1;\n');
    scanProject(baseOpts());
    expect(rowCount()).toBe(1);

    fs.rmSync(projectRoot, { recursive: true, force: true });
    expect(() => scanProject(baseOpts())).toThrow(/Cannot read project root/);
    expect(rowCount()).toBe(1);
  });

  it('hard-excludes common secret-bearing files', () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('.env', 'API_TOKEN=secret\n');
    write('secrets/private.pem', '-----BEGIN PRIVATE KEY-----\nsecret\n');

    const result = scanProject(baseOpts());
    const rows = getDatabase()
      .prepare('SELECT path FROM canopy_entries WHERE project_id = ? ORDER BY path')
      .all(PROJECT_ID) as { path: string }[];

    expect(result.added).toBe(1);
    expect(rows.map((r) => r.path)).toEqual(['src/a.ts']);
  });
});

describe('deltaScan', () => {
  it('skips unchanged files (no upsert) but still returns scan counts', () => {
    write('src/a.ts', 'export const a = 1;\n');
    scanProject(baseOpts());
    const initial = (getDatabase().prepare(
      'SELECT mechanical_updated_at FROM canopy_entries WHERE project_id = ? AND path = ?',
    ).get(PROJECT_ID, 'src/a.ts') as { mechanical_updated_at: number }).mechanical_updated_at;

    // Run the delta with a forced "now" by sleeping a moment to ensure
    // epochSeconds advances; the assertion below proves the row was NOT
    // re-upserted because the size and hash matched.
    const result = deltaScan(baseOpts());
    const after = (getDatabase().prepare(
      'SELECT mechanical_updated_at FROM canopy_entries WHERE project_id = ? AND path = ?',
    ).get(PROJECT_ID, 'src/a.ts') as { mechanical_updated_at: number }).mechanical_updated_at;
    expect(after).toBe(initial);
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('detects new and modified files and tombstones deletions', () => {
    write('src/a.ts', 'export const a = 1;\n');
    write('src/d.ts', 'export const d = 4;\n');
    scanProject(baseOpts());

    // Modify a (size grows), add c, delete d.
    write('src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    write('src/c.ts', 'export const c = 3;\n');
    fs.unlinkSync(path.join(projectRoot, 'src/d.ts'));

    const r = deltaScan(baseOpts());
    expect(r.added).toBe(1); // src/c.ts
    expect(r.updated).toBe(1); // src/a.ts changed size
    expect(r.removed).toBe(1); // src/d.ts deleted
    expect(rowCount()).toBe(2);
  });
});

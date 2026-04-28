import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase } from '../../db/client.js';
import { createCanopyTools } from './canopy-tools.js';
import type { VaultToolDeps } from './types.js';

function seedSchema(db: Database) {
  // Schema seed: hardcoded, no untrusted input
  const schema = `
    CREATE TABLE canopy_entries (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT,
      exports_json TEXT,
      imports_json TEXT,
      top_comment TEXT,
      llm_description TEXT,
      llm_updated_at INTEGER,
      mechanical_updated_at INTEGER NOT NULL,
      embedded INTEGER DEFAULT 0,
      PRIMARY KEY (project_id, path)
    );
  `;
  db.exec(schema);
}

async function invoke(t: any, args: Record<string, unknown>): Promise<unknown> {
  const result = await t.handler(args);
  return JSON.parse(result.content[0].text);
}

describe('canopy_describe_next', () => {
  const projectRoot = '/tmp/myco-test-project-canopy-tools';
  const deps = { agentId: 'a', runId: 'r', projectRoot, vaultDir: `${projectRoot}/.myco` } as VaultToolDeps;
  let db: Database;

  beforeEach(() => {
    closeDatabase();
    db = initDatabase(':memory:');
    seedSchema(db);
  });

  it('returns up to limit pending rows when canopy_entry_path is unset', async () => {
    db.prepare('INSERT INTO canopy_entries (project_id, path, mechanical_updated_at) VALUES (?, ?, ?)').run(projectRoot, 'a.ts', 100);
    db.prepare('INSERT INTO canopy_entries (project_id, path, mechanical_updated_at) VALUES (?, ?, ?)').run(projectRoot, 'b.ts', 100);

    const tools = createCanopyTools(deps);
    const next = tools.find((t) => t.name === 'canopy_describe_next')!;
    const result = await invoke(next, { limit: 10 }) as { entries: any[] };
    expect(result.entries).toHaveLength(2);
  });

  it('returns the one row matching canopy_entry_path, bypassing pending predicate', async () => {
    db.prepare(
      'INSERT INTO canopy_entries (project_id, path, llm_description, llm_updated_at, mechanical_updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(projectRoot, 'src/foo.ts', 'old description', 200, 100);

    const tools = createCanopyTools(deps);
    const next = tools.find((t) => t.name === 'canopy_describe_next')!;
    const result = await invoke(next, { canopy_entry_path: 'src/foo.ts' }) as { entries: any[] };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].path).toBe('src/foo.ts');
  });

  it('returns empty entries when canopy_entry_path matches no row', async () => {
    const tools = createCanopyTools(deps);
    const next = tools.find((t) => t.name === 'canopy_describe_next')!;
    const result = await invoke(next, { canopy_entry_path: 'does/not/exist.ts' }) as { entries: any[] };
    expect(result.entries).toHaveLength(0);
  });
});

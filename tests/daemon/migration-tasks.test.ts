import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { runPendingMigrationTasks } from '@myco/daemon/migration-tasks.js';
import { getDatabase } from '@myco/db/client.js';

const silentLogger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

function makeEmbeddingManager(rebuildAll = vi.fn<[], { queued: number }>().mockReturnValue({ queued: 0 })) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rebuildAll } as any;
}

describe('runPendingMigrationTasks', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => { cleanTestDb(); });

  it('runs pending tasks on first call and records completion', async () => {
    const db = getDatabase();
    const rebuildAll = vi.fn<[], { queued: number }>().mockReturnValue({ queued: 42 });
    const embeddingManager = makeEmbeddingManager(rebuildAll);

    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });

    expect(rebuildAll).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare(`SELECT name FROM migration_tasks`)
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.name)).toContain('vector-metadata-reindex-0.21.1');
  });

  it('is idempotent across restarts — tasks do not re-run once recorded', async () => {
    const db = getDatabase();
    const rebuildAll = vi.fn<[], { queued: number }>().mockReturnValue({ queued: 0 });
    const embeddingManager = makeEmbeddingManager(rebuildAll);

    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });
    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });
    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });

    expect(rebuildAll).toHaveBeenCalledTimes(1);
  });

  it('does not record completion when a task throws — retries next run', async () => {
    const db = getDatabase();
    const rebuildAll = vi.fn<[], { queued: number }>()
      .mockImplementationOnce(() => { throw new Error('boom'); })
      .mockReturnValueOnce({ queued: 5 });
    const embeddingManager = makeEmbeddingManager(rebuildAll);

    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });
    const afterFirst = db.prepare(`SELECT COUNT(*) AS n FROM migration_tasks`).get() as { n: number };
    expect(afterFirst.n).toBe(0);

    await runPendingMigrationTasks({ db, embeddingManager, logger: silentLogger });
    const afterSecond = db.prepare(`SELECT COUNT(*) AS n FROM migration_tasks`).get() as { n: number };
    expect(afterSecond.n).toBeGreaterThan(0);
    expect(rebuildAll).toHaveBeenCalledTimes(2);
  });
});

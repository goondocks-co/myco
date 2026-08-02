/**
 * Per-site SchemaVersionTooNewError responses (the counterpart of the
 * call-site registry meta-gate in create-schema-call-sites.test.ts).
 * Each production `createSchema` caller must respond deliberately to a
 * too-new vault; these tests prove the response at every site testable
 * outside a full daemon boot. The boot site's marker+exit(0) response is
 * covered by tests/daemon/schema-refusal.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, SchemaVersionTooNewError } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { createGroveId } from '@myco/grove/ids.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-too-new-handlers-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Create a vault stamped one version NEWER than this binary supports. */
function createTooNewVault(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION + 1, epochSeconds());
  } finally {
    db.close();
  }
}

describe('grove-runtime-cache on a too-new vault', () => {
  it('throws typed per request, caches nothing, and keeps serving other Groves', () => {
    const tooNewPath = path.join(workDir, 'groves', createGroveId(), 'myco.db');
    createTooNewVault(tooNewPath);
    const healthyPath = path.join(workDir, 'groves', createGroveId(), 'myco.db');
    fs.mkdirSync(path.dirname(healthyPath), { recursive: true });

    const cache = new GroveRuntimeCache();
    // Typed on the first attempt AND on a retry — a broken entry must
    // never be cached and served.
    expect(() => cache.getDatabase(tooNewPath)).toThrow(SchemaVersionTooNewError);
    expect(() => cache.getDatabase(tooNewPath)).toThrow(SchemaVersionTooNewError);

    // The same cache still opens a healthy Grove: the refusal is
    // per-Grove, not process-fatal.
    const healthyDb = cache.getDatabase(healthyPath);
    expect(
      (healthyDb.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
        .get() as { version: number }).version,
    ).toBe(SCHEMA_VERSION);
  });
});

describe('ensureGroveDatabase on a too-new vault', () => {
  it('propagates the typed error without wrapping it', () => {
    const groveId = createGroveId();
    const mycoHome = path.join(workDir, 'home');
    createTooNewVault(path.join(mycoHome, 'groves', groveId, 'myco.db'));

    expect(() => ensureGroveDatabase(groveId, mycoHome)).toThrow(SchemaVersionTooNewError);
  });
});

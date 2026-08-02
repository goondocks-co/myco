import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { createGroveId } from '@myco/grove/ids.js';
import { versionDir } from '@myco/install/managed-binary.js';
import {
  readMaxStampedSchemaVersion,
  readSupportedSchemaVersion,
  rollbackWouldCrossSchemaGap,
  SchemaGapDowngradeError,
  stampSupportedSchemaVersion,
} from '@myco/upgrade/schema-gap.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-gap-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function createGroveVault(stampOverride?: number): string {
  const groveId = createGroveId();
  const dbPath = path.join(home, 'groves', groveId, 'myco.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    if (stampOverride !== undefined) {
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(stampOverride, epochSeconds());
    }
  } finally {
    db.close();
  }
  return dbPath;
}

describe('readMaxStampedSchemaVersion', () => {
  it('returns null for a home with no groves dir', () => {
    expect(readMaxStampedSchemaVersion(path.join(home, 'nope'))).toBeNull();
  });

  it('returns the MAX across Groves, not the boot Grove alone', () => {
    createGroveVault(SCHEMA_VERSION - 3);
    createGroveVault(SCHEMA_VERSION + 2);
    createGroveVault();

    expect(readMaxStampedSchemaVersion(home)).toBe(SCHEMA_VERSION + 2);
  });

  it('skips unreadable Groves instead of failing the scan', () => {
    createGroveVault();
    const brokenDir = path.join(home, 'groves', createGroveId());
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'myco.db'), 'not a sqlite file');

    expect(readMaxStampedSchemaVersion(home)).toBe(SCHEMA_VERSION);
  });
});

describe('supported-schema self-stamp', () => {
  it('stamps into an existing version slot and reads back', () => {
    const dir = versionDir(home, 'linux', '1.3.0');
    fs.mkdirSync(dir, { recursive: true });

    stampSupportedSchemaVersion(home, 'linux', '1.3.0');
    expect(readSupportedSchemaVersion(home, 'linux', '1.3.0')).toBe(SCHEMA_VERSION);
    // Idempotent.
    stampSupportedSchemaVersion(home, 'linux', '1.3.0');
    expect(readSupportedSchemaVersion(home, 'linux', '1.3.0')).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(path.join(dir, 'schema-version.tmp'))).toBe(false);
  });

  it('never creates a missing version slot (the markAdoptFailed precedent)', () => {
    stampSupportedSchemaVersion(home, 'linux', '9.9.9');
    expect(fs.existsSync(versionDir(home, 'linux', '9.9.9'))).toBe(false);
    expect(readSupportedSchemaVersion(home, 'linux', '9.9.9')).toBeNull();
  });

  it('returns null for a garbage stamp', () => {
    const dir = versionDir(home, 'linux', '1.3.0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'schema-version'), 'garbage');
    expect(readSupportedSchemaVersion(home, 'linux', '1.3.0')).toBeNull();
  });
});

describe('rollbackWouldCrossSchemaGap', () => {
  it('no readable vault → allow', () => {
    expect(rollbackWouldCrossSchemaGap(null, 76)).toBe(false);
    expect(rollbackWouldCrossSchemaGap(null, null)).toBe(false);
  });

  it('vault ahead of candidate → refuse', () => {
    expect(rollbackWouldCrossSchemaGap(77, 76)).toBe(true);
  });

  it('candidate at or ahead of vault → allow', () => {
    expect(rollbackWouldCrossSchemaGap(76, 76)).toBe(false);
    expect(rollbackWouldCrossSchemaGap(76, 80)).toBe(false);
  });

  it('unknown candidate with a real vault → refuse (fail closed)', () => {
    expect(rollbackWouldCrossSchemaGap(76, null)).toBe(true);
  });
});

describe('SchemaGapDowngradeError', () => {
  it('carries the typed code and names versions + recovery in the message', () => {
    const known = new SchemaGapDowngradeError('1.2.13', 76, 71);
    expect(known.code).toBe('schema_gap_downgrade');
    expect(known.message).toContain('1.2.13');
    expect(known.message).toContain('v76');
    expect(known.message).toContain('v71');
    expect(known.message).toContain('restore a backup');

    const unknown = new SchemaGapDowngradeError('1.2.13', 76, null);
    expect(unknown.message).toContain('not known to support');
  });
});

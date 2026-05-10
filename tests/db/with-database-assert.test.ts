import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  withDatabase,
  setOwnedServiceDirForCurrentProcess,
  clearOwnedServiceDirForCurrentProcess,
} from '@myco/db/client.js';

describe('withDatabase ownership assertion', () => {
  let mycoHome: string;

  beforeEach(() => {
    mycoHome = mkdtempSync(path.join(tmpdir(), 'myco-wdb-'));
    mkdirSync(path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
    writeFileSync(
      path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'grove.toml'),
      `[grove]\nid = "grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nname = "Default"\nslug = "default"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00Z"\nserved_by = "service"\n`,
    );
    mkdirSync(path.join(mycoHome, 'service-dev'), { recursive: true });
    setOwnedServiceDirForCurrentProcess(path.join(mycoHome, 'service-dev'), mycoHome);
  });

  afterEach(() => {
    clearOwnedServiceDirForCurrentProcess();
  });

  it('throws when scoping a DB whose Grove is served by a different daemon', () => {
    const dbPath = path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'myco.db');
    const db = openDatabase(dbPath);
    try {
      expect(() => withDatabase(db, () => 'unreachable')).toThrow(/served by/);
    } finally {
      db.close();
    }
  });

  it('does not throw when no owner is declared (tests / one-shot scripts)', async () => {
    clearOwnedServiceDirForCurrentProcess();
    const dbPath = path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'myco.db');
    const db = openDatabase(dbPath);
    try {
      const result = await withDatabase(db, async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('does not throw when daemon owns the Grove', async () => {
    mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    setOwnedServiceDirForCurrentProcess(path.join(mycoHome, 'service'), mycoHome);
    const dbPath = path.join(mycoHome, 'groves', 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'myco.db');
    const db = openDatabase(dbPath);
    try {
      const result = await withDatabase(db, async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      db.close();
    }
  });
});

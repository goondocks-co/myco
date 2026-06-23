import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  withDatabase,
  setOwnedServiceDirForCurrentProcess,
  clearOwnedServiceDirForCurrentProcess,
} from '@myco/db/client.js';

describe('withDatabase ownership assertion', () => {
  let homeA: string;
  let homeB: string;
  const groveId = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    homeA = mkdtempSync(path.join(tmpdir(), 'myco-home-A-'));
    homeB = mkdtempSync(path.join(tmpdir(), 'myco-home-B-'));
    mkdirSync(path.join(homeA, 'groves', groveId), { recursive: true });
    mkdirSync(path.join(homeB, 'groves', groveId), { recursive: true });
  });

  afterEach(() => {
    clearOwnedServiceDirForCurrentProcess();
  });

  it('allows opening a Grove DB under the owning home', async () => {
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    const dbPath = path.join(homeA, 'groves', groveId, 'myco.db');
    const db = openDatabase(dbPath);
    try {
      const result = await withDatabase(db, async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('throws with "Cross-home" when opening a Grove DB from a foreign home', () => {
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    const foreignDbPath = path.join(homeB, 'groves', groveId, 'myco.db');
    const db = openDatabase(foreignDbPath);
    try {
      expect(() => withDatabase(db, () => 'unreachable')).toThrow(/Cross-home/);
    } finally {
      db.close();
    }
  });

  it('allows :memory: regardless of declared owner', () => {
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    const db = openDatabase(); // defaults to :memory:
    try {
      expect(() => withDatabase(db, () => 'ok')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('allows non-grove paths regardless of declared owner', async () => {
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    // A path that looks like a DB but has no grove-id segment.
    const db = openDatabase(path.join(homeA, 'state.db'));
    try {
      const result = await withDatabase(db, async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('does not throw when no owner is declared (tests / one-shot scripts)', async () => {
    clearOwnedServiceDirForCurrentProcess();
    const dbPath = path.join(homeA, 'groves', groveId, 'myco.db');
    const db = openDatabase(dbPath);
    try {
      const result = await withDatabase(db, async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      db.close();
    }
  });
});

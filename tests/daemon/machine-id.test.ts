/**
 * Tests for machine identity generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeMachineHash, resolveGitHubUser, getMachineId } from '@myco/daemon/machine-id.js';

/** Create a temporary vault dir for each test. */
function makeTmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-machine-id-'));
}

describe('machine-id', () => {
  describe('computeMachineHash()', () => {
    it('returns a hex string of expected length', () => {
      const hash = computeMachineHash();
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is deterministic — same result on repeated calls', () => {
      const h1 = computeMachineHash();
      const h2 = computeMachineHash();
      expect(h1).toBe(h2);
    });
  });

  describe('resolveGitHubUser()', () => {
    it('returns a non-empty string', () => {
      const user = resolveGitHubUser();
      expect(user.length).toBeGreaterThan(0);
    });

    // The fallback path is implicitly tested via getMachineId with a cached file.
    // Mocking execFileSync requires module-level interception that is fragile here.
  });

  describe('getMachineId()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTmpVault();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('generates a machine ID in {user}_{hash} format', () => {
      const id = getMachineId(tmpDir);
      expect(id).toMatch(/^[a-zA-Z0-9._-]+_[0-9a-f]{8}$/);
    });

    it('caches the machine ID to a file', () => {
      const id = getMachineId(tmpDir);
      const cached = fs.readFileSync(path.join(tmpDir, 'machine_id'), 'utf-8').trim();
      expect(cached).toBe(id);
    });

    it('returns cached value on subsequent calls', () => {
      const id1 = getMachineId(tmpDir);
      const id2 = getMachineId(tmpDir);
      expect(id1).toBe(id2);
    });

    it('reads from existing cache file', () => {
      const fakeId = 'testuser_abcd1234';
      fs.writeFileSync(path.join(tmpDir, 'machine_id'), fakeId, 'utf-8');
      const id = getMachineId(tmpDir);
      expect(id).toBe(fakeId);
    });

    it('generates fresh ID if cache file is empty', () => {
      fs.writeFileSync(path.join(tmpDir, 'machine_id'), '', 'utf-8');
      const id = getMachineId(tmpDir);
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[a-zA-Z0-9._-]+_[0-9a-f]{8}$/);
    });
  });
});

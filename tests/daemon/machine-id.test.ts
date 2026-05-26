/**
 * Tests for machine identity generation.
 *
 * Post-global-install: `getMachineId()` resolves from `~/.myco/machine_id`
 * (one identity per machine, shared across all Groves and projects). Tests
 * override `MYCO_HOME` to point at a tmp dir so the real user home isn't
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeMachineHash, resolveGitHubUser, getMachineId, propagateLegacyMachineId } from '@myco/daemon/machine-id.js';

/** Create an isolated MYCO_HOME so the test doesn't depend on or mutate `~/.myco`. */
function makeTmpHome(): string {
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
    let tmpHome: string;
    let priorEnv: string | undefined;

    beforeEach(() => {
      tmpHome = makeTmpHome();
      priorEnv = process.env.MYCO_HOME;
      process.env.MYCO_HOME = tmpHome;
    });

    afterEach(() => {
      if (priorEnv === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = priorEnv;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('generates a machine ID in {user}_{hash} format', () => {
      const id = getMachineId();
      expect(id).toMatch(/^[a-zA-Z0-9._-]+_[0-9a-f]{8}$/);
    });

    it('caches the machine ID to ~/.myco/machine_id', () => {
      const id = getMachineId();
      const cached = fs.readFileSync(path.join(tmpHome, 'machine_id'), 'utf-8').trim();
      expect(cached).toBe(id);
    });

    it('returns cached value on subsequent calls', () => {
      const id1 = getMachineId();
      const id2 = getMachineId();
      expect(id1).toBe(id2);
    });

    it('reads from existing cache file', () => {
      const fakeId = 'testuser_abcd1234';
      fs.writeFileSync(path.join(tmpHome, 'machine_id'), fakeId, 'utf-8');
      const id = getMachineId();
      expect(id).toBe(fakeId);
    });

    it('generates fresh ID if cache file is empty', () => {
      fs.writeFileSync(path.join(tmpHome, 'machine_id'), '', 'utf-8');
      const id = getMachineId();
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[a-zA-Z0-9._-]+_[0-9a-f]{8}$/);
    });
  });

  describe('propagateLegacyMachineId()', () => {
    let tmpHome: string;
    let tmpVault: string;
    let priorEnv: string | undefined;

    beforeEach(() => {
      tmpHome = makeTmpHome();
      tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-legacy-vault-'));
      priorEnv = process.env.MYCO_HOME;
      process.env.MYCO_HOME = tmpHome;
    });

    afterEach(() => {
      if (priorEnv === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = priorEnv;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpVault, { recursive: true, force: true });
    });

    it('copies legacy project machine_id into the global cache when global is absent', () => {
      const legacy = 'oldcontributor_deadbeef';
      fs.writeFileSync(path.join(tmpVault, 'machine_id'), legacy, 'utf-8');
      const propagated = propagateLegacyMachineId(tmpVault);
      expect(propagated).toBe(true);
      const global = fs.readFileSync(path.join(tmpHome, 'machine_id'), 'utf-8').trim();
      expect(global).toBe(legacy);
    });

    it('does not overwrite an existing global machine_id', () => {
      fs.writeFileSync(path.join(tmpHome, 'machine_id'), 'global_aaaa1111', 'utf-8');
      fs.writeFileSync(path.join(tmpVault, 'machine_id'), 'legacy_bbbb2222', 'utf-8');
      const propagated = propagateLegacyMachineId(tmpVault);
      expect(propagated).toBe(false);
      const global = fs.readFileSync(path.join(tmpHome, 'machine_id'), 'utf-8').trim();
      expect(global).toBe('global_aaaa1111');
    });

    it('returns false when the project has no legacy machine_id file', () => {
      const propagated = propagateLegacyMachineId(tmpVault);
      expect(propagated).toBe(false);
      expect(fs.existsSync(path.join(tmpHome, 'machine_id'))).toBe(false);
    });

    it('returns false when the legacy file is empty', () => {
      fs.writeFileSync(path.join(tmpVault, 'machine_id'), '', 'utf-8');
      const propagated = propagateLegacyMachineId(tmpVault);
      expect(propagated).toBe(false);
      expect(fs.existsSync(path.join(tmpHome, 'machine_id'))).toBe(false);
    });
  });
});

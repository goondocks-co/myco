import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  deleteSecrets,
  loadLayeredSecrets,
  loadSecrets,
  readSecrets,
  tightenSecretsPermissions,
  writeSecret,
} from '@myco/config/secrets';

const POSIX = process.platform !== 'win32';

describe('secrets', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('readSecrets', () => {
    it('returns empty object when secrets.env does not exist', () => {
      expect(readSecrets(testDir)).toEqual({});
    });

    it('parses key-value pairs', () => {
      fs.writeFileSync(path.join(testDir, 'secrets.env'), 'FOO=bar\nBAZ=qux\n', 'utf-8');
      expect(readSecrets(testDir)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('ignores comments and blank lines', () => {
      fs.writeFileSync(
        path.join(testDir, 'secrets.env'),
        '# This is a comment\nKEY=value\n\n',
        'utf-8',
      );
      expect(readSecrets(testDir)).toEqual({ KEY: 'value' });
    });

    it('handles values with equals signs', () => {
      fs.writeFileSync(path.join(testDir, 'secrets.env'), 'TOKEN=abc=def\n', 'utf-8');
      expect(readSecrets(testDir)).toEqual({ TOKEN: 'abc=def' });
    });
  });

  describe('writeSecret', () => {
    it('creates secrets.env when it does not exist', () => {
      writeSecret(testDir, 'API_KEY', 'sk-test');
      const content = fs.readFileSync(path.join(testDir, 'secrets.env'), 'utf-8');
      expect(content).toBe('API_KEY=sk-test\n');
    });

    it('preserves existing secrets and adds new ones', () => {
      writeSecret(testDir, 'FIRST', 'one');
      writeSecret(testDir, 'SECOND', 'two');
      const secrets = readSecrets(testDir);
      expect(secrets).toEqual({ FIRST: 'one', SECOND: 'two' });
    });

    it('overwrites existing key with new value', () => {
      writeSecret(testDir, 'KEY', 'old');
      writeSecret(testDir, 'KEY', 'new');
      expect(readSecrets(testDir)).toEqual({ KEY: 'new' });
    });
  });

  describe('loadSecrets', () => {
    it('loads secrets into process.env', () => {
      const envKey = 'MYCO_TEST_SECRET_' + Date.now();
      writeSecret(testDir, envKey, 'loaded');

      loadSecrets(testDir);
      expect(process.env[envKey]).toBe('loaded');

      // Cleanup
      delete process.env[envKey];
    });

    it('does not overwrite existing env vars', () => {
      const envKey = 'MYCO_TEST_EXISTING_' + Date.now();
      process.env[envKey] = 'original';
      writeSecret(testDir, envKey, 'from-secrets');

      loadSecrets(testDir);
      expect(process.env[envKey]).toBe('original');

      // Cleanup
      delete process.env[envKey];
    });

    it('is a no-op when secrets.env does not exist', () => {
      // Should not throw
      loadSecrets(testDir);
    });
  });

  describe('loadLayeredSecrets', () => {
    it('loads later stores with higher precedence', () => {
      const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-legacy-'));
      const machineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-machine-'));
      const groveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-grove-'));
      const envKey = `MYCO_TEST_LAYERED_${Date.now()}`;
      const env: NodeJS.ProcessEnv = {};

      try {
        writeSecret(legacyDir, envKey, 'legacy');
        writeSecret(machineDir, envKey, 'machine');
        writeSecret(groveDir, envKey, 'grove');

        loadLayeredSecrets([legacyDir, machineDir, groveDir], env);

        expect(env[envKey]).toBe('grove');
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true });
        fs.rmSync(machineDir, { recursive: true, force: true });
        fs.rmSync(groveDir, { recursive: true, force: true });
      }
    });

    it('does not overwrite env vars that were already present', () => {
      const machineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-machine-'));
      const envKey = `MYCO_TEST_LAYERED_EXISTING_${Date.now()}`;
      const env: NodeJS.ProcessEnv = { [envKey]: 'external' };

      try {
        writeSecret(machineDir, envKey, 'machine');

        loadLayeredSecrets([machineDir], env);

        expect(env[envKey]).toBe('external');
      } finally {
        fs.rmSync(machineDir, { recursive: true, force: true });
      }
    });
  });

  describe('filesystem permissions (G1)', () => {
    it('writeSecret writes the file with 0o600 perms', () => {
      writeSecret(testDir, 'API_KEY', 'sk-test');
      const stat = fs.statSync(path.join(testDir, 'secrets.env'));
      if (POSIX) {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('writeSecret tightens perms even when the file pre-exists with looser mode', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'PRE=existing\n', { mode: 0o644 });
      // Sanity: confirm fixture set the loose mode (POSIX only).
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o644);
      }
      writeSecret(testDir, 'API_KEY', 'sk-test');
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      }
    });

    it('writeSecret tightens parent dir perms to 0o700', () => {
      writeSecret(testDir, 'API_KEY', 'sk-test');
      if (POSIX) {
        expect(fs.statSync(testDir).mode & 0o777).toBe(0o700);
      }
    });

    it('deleteSecrets preserves 0o600 on the rewritten file', () => {
      writeSecret(testDir, 'KEEP', 'a');
      writeSecret(testDir, 'DROP', 'b');
      // Loosen the file to verify deleteSecrets re-tightens it.
      const secretsPath = path.join(testDir, 'secrets.env');
      if (POSIX) fs.chmodSync(secretsPath, 0o644);
      deleteSecrets(testDir, ['DROP']);
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      }
      expect(readSecrets(testDir)).toEqual({ KEEP: 'a' });
    });

    it('tightenSecretsPermissions retroactively chmod-tightens an existing loose file', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'KEY=value\n', { mode: 0o644 });
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o644);
      }
      tightenSecretsPermissions(testDir);
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      }
    });

    it('tightenSecretsPermissions is a no-op when secrets.env does not exist', () => {
      // Must not throw, must still tighten the dir perms.
      expect(() => tightenSecretsPermissions(testDir)).not.toThrow();
    });

    it('loadSecrets retroactively tightens existing-file perms at boot', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'BOOTKEY=value\n', { mode: 0o640 });
      loadSecrets(testDir);
      if (POSIX) {
        expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      }
      // Cleanup
      delete process.env.BOOTKEY;
    });
  });
});

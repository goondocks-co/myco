import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSecrets, writeSecret, loadSecrets } from '@myco/config/secrets';

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
});

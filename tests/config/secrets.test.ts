import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assertValidSecretEntry,
  deleteSecrets,
  InvalidSecretValueError,
  loadLayeredSecrets,
  loadSecrets,
  propagateLegacySecrets,
  readSecrets,
  tightenSecretsPermissions,
  writeSecret,
  writeSecretIfAbsent,
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

    it.each([
      ['a carriage-return line', 'BROKEN\rVALUE\nVALID=kept\n'],
      ['an unparseable line', 'BROKEN VALUE\nVALID=kept\n'],
      ['a NUL-containing value', 'TOKEN=abc\0def\n'],
    ])('rejects %s instead of dropping or returning it', (_label, content) => {
      fs.writeFileSync(path.join(testDir, 'secrets.env'), content);
      expect(() => readSecrets(testDir)).toThrow(InvalidSecretValueError);
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

    it.each([
      ['line feed', 'safe\nINJECTED=owned'],
      ['carriage return', 'safe\rINJECTED=owned'],
      ['NUL', 'safe\0INJECTED=owned'],
    ])('rejects a value containing %s before changing secrets.env', (_label, value) => {
      writeSecret(testDir, 'EXISTING', 'preserved');
      const secretsPath = path.join(testDir, 'secrets.env');
      const before = fs.readFileSync(secretsPath);

      expect(() => writeSecret(testDir, 'API_KEY', value)).toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath)).toEqual(before);
      expect(readSecrets(testDir)).toEqual({ EXISTING: 'preserved' });
    });

    it.each(['BAD\nKEY', 'BAD\rKEY', 'BAD\0KEY', 'BAD=KEY', ''])(
      'rejects an unsafe key before creating the secret directory: %p',
      (key) => {
        const target = path.join(testDir, 'not-created');
        expect(() => writeSecret(target, key, 'value')).toThrow(InvalidSecretValueError);
        expect(fs.existsSync(target)).toBe(false);
      },
    );

    it('refuses to rewrite a retained malformed entry during add or delete', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'KEEP=malformed\0value\nREMOVE=old\n');
      const before = fs.readFileSync(secretsPath);

      expect(() => writeSecret(testDir, 'NEW', 'safe')).toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath)).toEqual(before);

      expect(() => deleteSecrets(testDir, ['REMOVE'])).toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath)).toEqual(before);
    });

    it.each([
      ['carriage-return line', 'add', 'BROKEN\rVALUE\nREMOVE=old\n'],
      ['carriage-return line', 'delete', 'BROKEN\rVALUE\nREMOVE=old\n'],
      ['unparseable line', 'add', 'BROKEN VALUE\nREMOVE=old\n'],
      ['unparseable line', 'delete', 'BROKEN VALUE\nREMOVE=old\n'],
    ])('rejects a retained %s before %s changes bytes or permissions', (_label, operation, content) => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, content, { mode: 0o644 });
      const before = fs.readFileSync(secretsPath);
      const beforeMode = fs.statSync(secretsPath).mode & 0o777;

      const mutate = operation === 'add'
        ? () => writeSecret(testDir, 'NEW', 'safe')
        : () => deleteSecrets(testDir, ['REMOVE']);
      expect(mutate).toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath)).toEqual(before);
      if (POSIX) expect(fs.statSync(secretsPath).mode & 0o777).toBe(beforeMode);
    });

    it.each(['add', 'delete'])(
      'preserves a __proto__ entry when a later %s rewrites the file',
      (operation) => {
        const secretsPath = path.join(testDir, 'secrets.env');
        fs.writeFileSync(secretsPath, '__proto__=preserved\nREMOVE=old\n');

        const before = readSecrets(testDir);
        expect(Object.hasOwn(before, '__proto__')).toBe(true);
        expect(before.__proto__).toBe('preserved');

        if (operation === 'add') {
          writeSecret(testDir, 'NEW', 'safe');
        } else {
          deleteSecrets(testDir, ['REMOVE']);
        }

        const after = readSecrets(testDir);
        expect(Object.hasOwn(after, '__proto__')).toBe(true);
        expect(after.__proto__).toBe('preserved');
      },
    );

    it('rejects deletion of the malformed target instead of unlinking its file', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'REMOVE=malformed\0value\n');
      const before = fs.readFileSync(secretsPath);

      expect(() => deleteSecrets(testDir, ['REMOVE'])).toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath)).toEqual(before);
    });

    it('rejects an invalid delete key before creating or changing its target', () => {
      const target = path.join(testDir, 'not-created');
      expect(() => deleteSecrets(target, ['BAD\nKEY'])).toThrow(InvalidSecretValueError);
      expect(fs.existsSync(target)).toBe(false);
    });

    it.each([
      ['key', { unsafe: true }, 'value'],
      ['value', 'KEY', { unsafe: true }],
    ])('rejects a non-string runtime %s without coercion', (_field, key, value) => {
      expect(() => assertValidSecretEntry(key as string, value as string))
        .toThrow(InvalidSecretValueError);
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

  // Regression: the global-install migration must propagate project-scope
  // secrets to the machine-wide secrets.env BEFORE purging the project
  // file. Without this, user API keys stored at the project level vanish
  // on first migration. See vault spore + code-review finding C3.
  describe('propagateLegacySecrets', () => {
    let projectDir: string;
    let mycoHomeDir: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-project-'));
      mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-home-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(mycoHomeDir, { recursive: true, force: true });
    });

    it('returns [] when project has no secrets.env', () => {
      expect(propagateLegacySecrets(projectDir, mycoHomeDir)).toEqual([]);
    });

    it('does not inspect the destination when the project has no secrets to propagate', () => {
      const destinationPath = path.join(mycoHomeDir, 'secrets.env');
      fs.writeFileSync(destinationPath, 'BROKEN VALUE\n');
      const before = fs.readFileSync(destinationPath);

      expect(propagateLegacySecrets(projectDir, mycoHomeDir)).toEqual([]);
      expect(fs.readFileSync(destinationPath)).toEqual(before);
    });

    it('lifts every project key when global secrets.env is absent', () => {
      writeSecret(projectDir, 'ANTHROPIC_API_KEY', 'sk-ant-legacy');
      writeSecret(projectDir, 'OPENAI_API_KEY', 'sk-openai-legacy');

      const propagated = propagateLegacySecrets(projectDir, mycoHomeDir);

      expect(propagated.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
      expect(readSecrets(mycoHomeDir)).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-legacy',
        OPENAI_API_KEY: 'sk-openai-legacy',
      });
    });

    it('global value wins on conflict — only absent keys are lifted', () => {
      writeSecret(projectDir, 'ANTHROPIC_API_KEY', 'sk-ant-project-OLD');
      writeSecret(projectDir, 'TEAM_TOKEN', 'team-from-project');
      writeSecret(mycoHomeDir, 'ANTHROPIC_API_KEY', 'sk-ant-machine-NEW');

      const propagated = propagateLegacySecrets(projectDir, mycoHomeDir);

      expect(propagated).toEqual(['TEAM_TOKEN']);
      expect(readSecrets(mycoHomeDir)).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-machine-NEW',
        TEAM_TOKEN: 'team-from-project',
      });
    });

    it('is idempotent — a second call after migration is a no-op', () => {
      writeSecret(projectDir, 'KEY_A', 'a');
      writeSecret(projectDir, 'KEY_B', 'b');

      const first = propagateLegacySecrets(projectDir, mycoHomeDir);
      expect(first.sort()).toEqual(['KEY_A', 'KEY_B']);

      const second = propagateLegacySecrets(projectDir, mycoHomeDir);
      expect(second).toEqual([]);
    });

    it('written global file has 0o600 perms (POSIX)', () => {
      writeSecret(projectDir, 'SENSITIVE', 'hush');
      propagateLegacySecrets(projectDir, mycoHomeDir);
      if (POSIX) {
        expect(fs.statSync(path.join(mycoHomeDir, 'secrets.env')).mode & 0o777).toBe(0o600);
      }
    });

    it('rejects a malformed source before partially mutating the destination', () => {
      const sourcePath = path.join(projectDir, 'secrets.env');
      const destinationPath = path.join(mycoHomeDir, 'secrets.env');
      fs.writeFileSync(sourcePath, 'FIRST=one\nBROKEN\rVALUE\nSECOND=two\n');
      fs.writeFileSync(destinationPath, 'EXISTING=preserved\n');
      const sourceBefore = fs.readFileSync(sourcePath);
      const destinationBefore = fs.readFileSync(destinationPath);

      expect(() => propagateLegacySecrets(projectDir, mycoHomeDir))
        .toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(fs.readFileSync(destinationPath)).toEqual(destinationBefore);
    });

    it('rejects a malformed destination before rewriting either store', () => {
      const sourcePath = path.join(projectDir, 'secrets.env');
      const destinationPath = path.join(mycoHomeDir, 'secrets.env');
      fs.writeFileSync(sourcePath, 'NEW=value\n');
      fs.writeFileSync(destinationPath, 'BROKEN VALUE\nEXISTING=preserved\n');
      const sourceBefore = fs.readFileSync(sourcePath);
      const destinationBefore = fs.readFileSync(destinationPath);

      expect(() => propagateLegacySecrets(projectDir, mycoHomeDir))
        .toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(fs.readFileSync(destinationPath)).toEqual(destinationBefore);
    });
  });

  describe('writeSecretIfAbsent (cross-process mint hardening)', () => {
    const KEY = 'MYCO_HOST_SERVE_BEARER';
    // Mirrors the private `mintClaimPath` layout in config/secrets.ts — the
    // interleave test pre-creates this exact file to stand in for a concurrent
    // process's claim (we cannot fork a real second process in the suite).
    const claimPathFor = (dir: string) => path.join(dir, `secrets.env.${KEY}.mint-claim`);

    it('mints once, stores the value, and reports minted:true on a fresh key', () => {
      const result = writeSecretIfAbsent(testDir, KEY, () => 'freshly-minted');
      expect(result).toEqual({ value: 'freshly-minted', minted: true });
      expect(readSecrets(testDir)[KEY]).toBe('freshly-minted');
      // No lingering secret-bearing claim file after a normal (uncontended) mint.
      expect(fs.existsSync(claimPathFor(testDir))).toBe(false);
    });

    it('a second sequential minter ADOPTS the first stored token (fast path) — never re-mints', () => {
      const winner = writeSecretIfAbsent(testDir, KEY, () => 'winner-token');
      expect(winner.minted).toBe(true);

      let loserMintCalled = false;
      const loser = writeSecretIfAbsent(testDir, KEY, () => { loserMintCalled = true; return 'loser-token'; });
      expect(loser).toEqual({ value: 'winner-token', minted: false });
      expect(loserMintCalled).toBe(false); // fast path never mints
      // ONE stored token — the winner's — and never the loser's candidate.
      expect(readSecrets(testDir)[KEY]).toBe('winner-token');
    });

    it('the loser observes the winner CLAIM mid-mint (EEXIST) and converges on the winner token', () => {
      // Simulate the cross-process interleave AT THE FS LAYER: the winner has
      // atomically claimed (its candidate sits in the claim file) but has NOT
      // yet merged into secrets.env — the precise window a plain
      // read→mint→write would corrupt. secrets.env is still absent, so the
      // loser passes its fast-path read and mints its OWN candidate, then hits
      // EEXIST on the claim and must adopt the winner's value instead.
      fs.writeFileSync(claimPathFor(testDir), 'winner-token', { mode: 0o600 });

      let loserCandidate: string | undefined;
      const loser = writeSecretIfAbsent(testDir, KEY, () => { loserCandidate = 'loser-token'; return loserCandidate; });

      expect(loser.value).toBe('winner-token'); // adopted the winner's, not its own
      expect(loser.minted).toBe(false);
      expect(loserCandidate).toBe('loser-token'); // the loser DID mint a candidate…
      // …but discarded it: the single stored token is the winner's, and the
      // loser persisted it to the canonical store (winner was still mid-mint).
      expect(readSecrets(testDir)[KEY]).toBe('winner-token');
    });

    it('written secrets.env stays 0o600 after a mint (POSIX)', () => {
      writeSecretIfAbsent(testDir, KEY, () => 'perm-check');
      if (POSIX) {
        expect(fs.statSync(path.join(testDir, 'secrets.env')).mode & 0o777).toBe(0o600);
      }
    });

    it('rejects an unsafe minted candidate without leaving a secret or claim file', () => {
      expect(() => writeSecretIfAbsent(testDir, KEY, () => 'unsafe\ncandidate'))
        .toThrow(InvalidSecretValueError);
      expect(fs.existsSync(path.join(testDir, 'secrets.env'))).toBe(false);
      expect(fs.existsSync(claimPathFor(testDir))).toBe(false);
    });

    it('rejects a malformed stored fast-path value without returning or mutating it', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, `${KEY}=abc\0def\n`);
      const before = fs.readFileSync(secretsPath);
      let mintCalled = false;

      expect(() => writeSecretIfAbsent(testDir, KEY, () => {
        mintCalled = true;
        return 'candidate';
      })).toThrow(InvalidSecretValueError);
      expect(mintCalled).toBe(false);
      expect(fs.readFileSync(secretsPath)).toEqual(before);
    });

    it('rejects malformed claim content before returning or persisting it', () => {
      const claimPath = claimPathFor(testDir);
      fs.writeFileSync(claimPath, 'winner-token\n', { mode: 0o600 });
      const claimBefore = fs.readFileSync(claimPath);

      expect(() => writeSecretIfAbsent(testDir, KEY, () => 'loser-token'))
        .toThrow(InvalidSecretValueError);
      expect(fs.existsSync(path.join(testDir, 'secrets.env'))).toBe(false);
      expect(fs.readFileSync(claimPath)).toEqual(claimBefore);
    });
  });
});

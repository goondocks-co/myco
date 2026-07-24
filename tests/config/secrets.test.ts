import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { spawn } from 'node:child_process';
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
  withLegacyTeamSecretSnapshotsReconciledSync,
} from '@myco/config/secrets';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';
import { secretStoreLockKeys } from '@myco/config/secret-store-lock.js';
import { physicalPathLockIdentities } from '@myco/utils/physical-path-identity.js';

const POSIX = process.platform !== 'win32';
const SECRETS_LOCK_HOLDER_HELPER = path.resolve('tests/helpers/secrets-lock-holder-helper.ts');
const CASE_INSENSITIVE_TMP = (() => {
  if (process.platform !== 'darwin') return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MycoCaseProbe-'));
  const upper = path.join(root, 'StoreN');
  const lower = path.join(root, 'storen');
  try {
    fs.mkdirSync(upper);
    return fs.existsSync(lower)
      && fs.statSync(upper).dev === fs.statSync(lower).dev
      && fs.statSync(upper).ino === fs.statSync(lower).ino;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
const CASE_SENSITIVE_TMP = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MycoCaseSensitiveProbe-'));
  const upper = path.join(root, 'StoreN');
  const lower = path.join(root, 'storen');
  try {
    fs.mkdirSync(upper);
    try {
      fs.mkdirSync(lower);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    return fs.statSync(upper).ino !== fs.statSync(lower).ino
      || fs.statSync(upper).dev !== fs.statSync(lower).dev;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

async function runSecretStoreRace(
  holderVaultDir: string,
  writerVaultDir: string,
  ready: string,
  mode: 'materialize' | 'write-race' = 'materialize',
): Promise<number> {
  const child = spawn(
    process.execPath,
    ['run', SECRETS_LOCK_HOLDER_HELPER, holderVaultDir, '400', mode, ready],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: process.cwd(),
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  const childExit = new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`materialized-store holder exited ${code}: ${stderr}`)));
    child.on('error', reject);
  });

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error(`materialized-store holder never signalled readiness: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (mode === 'materialize') {
    expect(fs.statSync(holderVaultDir).isDirectory()).toBe(true);
  } else {
    expect(fs.existsSync(holderVaultDir)).toBe(false);
  }

  const startedAt = Date.now();
  writeSecret(writerVaultDir, 'PARENT_WRITER', 'parent');
  const blockedMs = Date.now() - startedAt;
  await childExit;
  return blockedMs;
}

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

    const validRecords = [
      '  # comment',
      '',
      'ONE=first',
      'EMPTY=',
      'ONE=last',
      'TOKEN=abc=def',
    ];
    it.each([
      ['LF records', validRecords.join('\n') + '\n'],
      ['CRLF records', validRecords.join('\r\n') + '\r\n'],
    ])('parses valid %s', (_label, content) => {
      fs.writeFileSync(path.join(testDir, 'secrets.env'), content, 'utf-8');
      expect(readSecrets(testDir)).toEqual({ ONE: 'last', EMPTY: '', TOKEN: 'abc=def' });
    });

    it.each([
      ['a carriage-return line', 'BROKEN\rVALUE\nVALID=kept\n'],
      ['a bare carriage return at EOF', 'VALID=kept\r'],
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

    it.skipIf(!POSIX)('durably publishes a regular secret write before returning', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      const events: string[] = [];
      const fdPaths = new Map<number, string>();
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const open = vi.spyOn(fs, 'openSync').mockImplementation(
        ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          const fd = originalOpen(target, flags, mode);
          fdPaths.set(fd, String(target));
          return fd;
        }) as typeof fs.openSync,
      );
      const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        events.push(`fsync:${fdPaths.get(fd) ?? 'unknown'}`);
        originalFsync(fd);
      });
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        events.push(`rename:${String(source)}:${String(destination)}`);
        originalRename(source, destination);
      });

      try {
        writeSecret(testDir, 'API_KEY', 'secret');
      } finally {
        rename.mockRestore();
        fsync.mockRestore();
        open.mockRestore();
      }

      const publish = events.findIndex((event) => event.endsWith(`:${secretsPath}`));
      expect(publish).toBeGreaterThanOrEqual(0);
      expect(events.findIndex((event, index) => index > publish && event === `fsync:${testDir}`))
        .toBeGreaterThan(publish);
    });

    it.skipIf(!POSIX)('durably publishes removal of the last secret before returning', () => {
      writeSecret(testDir, 'ONLY_KEY', 'secret');
      const secretsPath = path.join(testDir, 'secrets.env');
      const events: string[] = [];
      const fdPaths = new Map<number, string>();
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const open = vi.spyOn(fs, 'openSync').mockImplementation(
        ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          const fd = originalOpen(target, flags, mode);
          fdPaths.set(fd, String(target));
          return fd;
        }) as typeof fs.openSync,
      );
      const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        events.push(`fsync:${fdPaths.get(fd) ?? 'unknown'}`);
        originalFsync(fd);
      });
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        events.push(`rename:${String(source)}:${String(destination)}`);
        originalRename(source, destination);
      });

      try {
        deleteSecrets(testDir, ['ONLY_KEY']);
      } finally {
        rename.mockRestore();
        fsync.mockRestore();
        open.mockRestore();
      }

      const removal = events.findIndex((event) => event.startsWith(`rename:${secretsPath}:`));
      expect(removal).toBeGreaterThanOrEqual(0);
      expect(events.findIndex((event, index) => index > removal && event === `fsync:${testDir}`))
        .toBeGreaterThan(removal);
      expect(fs.existsSync(secretsPath)).toBe(false);
    });

    it('reconciles an interrupted secret-removal tombstone while preserving unrelated state', () => {
      const secretTombstone = path.join(testDir, '.myco-remove-secrets.env-123-token');
      const unrelatedTombstone = path.join(testDir, '.myco-remove-membership.json-123-token');
      fs.writeFileSync(secretTombstone, 'ONLY_KEY=retired\n', { mode: 0o600 });
      fs.writeFileSync(unrelatedTombstone, '{}\n');

      deleteSecrets(testDir, ['ONLY_KEY']);

      expect(fs.existsSync(secretTombstone)).toBe(false);
      expect(fs.existsSync(unrelatedTombstone)).toBe(true);
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
      'refuses to rewrite a prototype-like retained key during %s',
      (operation) => {
        const secretsPath = path.join(testDir, 'secrets.env');
        fs.writeFileSync(secretsPath, '__proto__=preserved\nREMOVE=old\n');
        const before = fs.readFileSync(secretsPath);

        const mutate = operation === 'add'
          ? () => writeSecret(testDir, 'NEW', 'safe')
          : () => deleteSecrets(testDir, ['REMOVE']);

        expect(mutate).toThrow(InvalidSecretValueError);
        expect(fs.readFileSync(secretsPath)).toEqual(before);
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

    it.each([
      '__proto__',
      'prototype',
      'constructor',
      '9STARTS_WITH_DIGIT',
      'HAS-DASH',
      'HAS.DOT',
      'HAS SPACE',
      '#COMMENT',
      ' LEADING',
      'TRAILING ',
      'UNICODE_🔐',
    ])('rejects unsupported environment key %p before creating the store', (key) => {
      const target = path.join(testDir, 'invalid-key-store');
      expect(() => writeSecret(target, key, 'value')).toThrow(InvalidSecretValueError);
      expect(fs.existsSync(target)).toBe(false);
    });

    it.each([' leading', 'trailing ', '\tleading', 'trailing\t'])(
      'rejects a value whose serialization would trim or mutate it: %p',
      (value) => {
        const target = path.join(testDir, 'invalid-value-store');
        expect(() => writeSecret(target, 'API_KEY', value)).toThrow(InvalidSecretValueError);
        expect(fs.existsSync(target)).toBe(false);
      },
    );

    it.each([
      'API_KEY= leading\n',
      'API_KEY=trailing \n',
      'API_KEY=\tleading\n',
      'API_KEY=trailing\t\n',
    ])('rejects surrounding value whitespace from the exact file bytes: %p', (content) => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, content, { mode: 0o600 });

      expect(() => readSecrets(testDir)).toThrow(InvalidSecretValueError);
      expect(() => loadSecrets(testDir, Object.create(null) as NodeJS.ProcessEnv))
        .toThrow(InvalidSecretValueError);
      expect(fs.readFileSync(secretsPath, 'utf-8')).toBe(content);
    });

    it('round-trips representative provider keys exactly through file and ProcessEnv loading', () => {
      const entries = {
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: 'sk-anthropic',
        AWS_ACCESS_KEY_ID: 'aws-id',
        MYCO_TEAM_API_KEY: 'team-token',
        _PROVIDER_TOKEN_2: 'provider-token',
      };
      const env = Object.create(null) as NodeJS.ProcessEnv;

      for (const [key, value] of Object.entries(entries)) writeSecret(testDir, key, value);
      expect(readSecrets(testDir)).toEqual(entries);

      loadLayeredSecrets([testDir], env);
      expect(env).toEqual(entries);
      for (const key of Object.keys(entries)) expect(Object.hasOwn(env, key)).toBe(true);
    });

    it('rejects a prototype-like file key before loading any value into ProcessEnv', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'SAFE=value\n__proto__=blocked\n', { mode: 0o600 });
      const env = Object.create(null) as NodeJS.ProcessEnv;

      expect(() => loadLayeredSecrets([testDir], env)).toThrow(InvalidSecretValueError);
      expect(env).toEqual({});
    });
  });

  it.each([
    '.', '..', '../escape', 'nested/backup',
    'team.json', 'host.json', 'secrets.env.API_KEY.mint-claim', 'arbitrary.env',
  ])('rejects an arbitrary legacy Team snapshot target: %p', (backupFileName) => {
    const source = path.join(testDir, 'source');
    const destination = path.join(testDir, 'destination');
    writeSecret(source, 'SOURCE', 'source');
    writeSecret(destination, 'DESTINATION', 'destination');
    const before = fs.readFileSync(path.join(destination, 'secrets.env'));

    expect(() => withLegacyTeamSecretSnapshotsReconciledSync(
      [{ sourceVaultDir: source, destinationVaultDir: destination, backupFileName } as never],
      () => 'complete',
    )).toThrow();
    expect(fs.readFileSync(path.join(destination, 'secrets.env'))).toEqual(before);
  });

  it('rejects an asynchronous finalizer while secret-store locks are held', () => {
    const source = path.join(testDir, 'async-source');
    const destination = path.join(testDir, 'async-destination');
    writeSecret(source, 'SOURCE', 'source');
    expect(() => withLegacyTeamSecretSnapshotsReconciledSync(
      [{ sourceVaultDir: source, destinationVaultDir: destination }],
      (async () => 'complete') as never,
    )).toThrow();
    expect(fs.existsSync(path.join(destination, 'secrets.env'))).toBe(false);
  });

  it('rejects same-store aliases and duplicate stores before changing any snapshot', () => {
    const source = path.join(testDir, 'alias-source');
    const destination = path.join(testDir, 'alias-destination');
    const other = path.join(testDir, 'alias-other');
    writeSecret(source, 'SOURCE', 'source');
    const before = fs.readFileSync(path.join(source, 'secrets.env'));

    expect(() => withLegacyTeamSecretSnapshotsReconciledSync(
      [{ sourceVaultDir: source, destinationVaultDir: source }],
      () => 'complete',
    )).toThrow();
    expect(() => withLegacyTeamSecretSnapshotsReconciledSync(
      [
        { sourceVaultDir: source, destinationVaultDir: destination },
        { sourceVaultDir: other, destinationVaultDir: destination },
      ],
      () => 'complete',
    )).toThrow();
    expect(fs.readFileSync(path.join(source, 'secrets.env'))).toEqual(before);
    expect(fs.existsSync(path.join(destination, 'secrets.env'))).toBe(false);
  });

  describe.skipIf(process.platform === 'win32')('cross-process secret-store transaction', () => {
    it('uses a private, real, uid-owned lock root outside HOME and TMPDIR', () => {
      const lockRoot = resolvePerUserLocksDir();
      const stat = fs.lstatSync(lockRoot);

      expect(lockRoot).toBe(`/var/tmp/myco-locks-${process.getuid!()}`);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.uid).toBe(process.getuid!());
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it.skipIf(!CASE_SENSITIVE_TMP)(
      'keeps existing differently-cased directories distinct on a case-sensitive volume',
      () => {
        const upperVaultDir = path.join(testDir, 'StoreN');
        const lowerVaultDir = path.join(testDir, 'storen');
        fs.mkdirSync(upperVaultDir);
        fs.mkdirSync(lowerVaultDir);

        expect(secretStoreLockKeys(upperVaultDir))
          .not.toEqual(secretStoreLockKeys(lowerVaultDir));
      },
    );

    it('serializes unrelated writers behind the same store lock without losing either entry', async () => {
      const holdMs = 400;
      const childTmp = path.join(testDir, 'child-tmp');
      fs.mkdirSync(childTmp);
      const childHome = path.join(testDir, 'child-home');
      fs.mkdirSync(childHome);
      const child = spawn(
        process.execPath,
        ['run', SECRETS_LOCK_HOLDER_HELPER, testDir, String(holdMs)],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: childHome,
            USERPROFILE: childHome,
            TMPDIR: childTmp,
            TMP: childTmp,
            TEMP: childTmp,
          },
        },
      );
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      const childExit = new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}: ${stderr}`)));
        child.on('error', reject);
      });

      const ready = path.join(testDir, 'secrets-lock-ready');
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error(`secret lock holder never signalled readiness: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const startedAt = Date.now();
      writeSecret(testDir, 'PARENT_WRITER', 'parent');
      const blockedMs = Date.now() - startedAt;
      await childExit;

      expect(readSecrets(testDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
      expect(blockedMs).toBeGreaterThanOrEqual(200);
    }, 30_000);

    it.skipIf(!CASE_INSENSITIVE_TMP)(
      'serializes differently-cased APFS aliases while the store is still missing',
      async () => {
        const upperVaultDir = path.join(testDir, 'StoreN');
        const lowerVaultDir = path.join(testDir, 'storen');
        const ready = path.join(testDir, 'missing-case-alias-lock-ready');

        const blockedMs = await runSecretStoreRace(
          upperVaultDir,
          lowerVaultDir,
          ready,
          'write-race',
        );

        expect(fs.statSync(upperVaultDir).ino).toBe(fs.statSync(lowerVaultDir).ino);
        expect(readSecrets(upperVaultDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
        expect(blockedMs).toBeGreaterThanOrEqual(200);
      },
      30_000,
    );

    it.skipIf(!CASE_INSENSITIVE_TMP)(
      'serializes differently-cased APFS aliases after the holder materializes the store',
      async () => {
        const upperVaultDir = path.join(testDir, 'PromotedStoreN');
        const lowerVaultDir = path.join(testDir, 'promotedstoren');
        const ready = path.join(testDir, 'promoted-case-alias-lock-ready');

        const blockedMs = await runSecretStoreRace(upperVaultDir, lowerVaultDir, ready);

        expect(fs.statSync(upperVaultDir).ino).toBe(fs.statSync(lowerVaultDir).ino);
        expect(readSecrets(upperVaultDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
        expect(blockedMs).toBeGreaterThanOrEqual(200);
      },
      30_000,
    );

    it.skipIf(!CASE_INSENSITIVE_TMP)(
      'keeps the transition lock when only an existing ancestor has a case alias',
      async () => {
        const canonicalParent = path.join(testDir, 'RootParent');
        const aliasParent = path.join(testDir, 'rootparent');
        fs.mkdirSync(canonicalParent);
        const holderVaultDir = path.join(canonicalParent, '123');
        const writerVaultDir = path.join(aliasParent, '123');
        const ready = path.join(testDir, 'ancestor-case-alias-lock-ready');

        const blockedMs = await runSecretStoreRace(holderVaultDir, writerVaultDir, ready);

        expect(fs.statSync(holderVaultDir).ino).toBe(fs.statSync(writerVaultDir).ino);
        expect(physicalPathLockIdentities(holderVaultDir).some((identity) => (
          identity.startsWith('casefold:')
        ))).toBe(true);
        expect(readSecrets(holderVaultDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
        expect(blockedMs).toBeGreaterThanOrEqual(200);
      },
      30_000,
    );

    it('serializes a multi-component missing store after the holder materializes it', async () => {
      const vaultDir = path.join(testDir, 'missing-parent', 'missing-store');
      const ready = path.join(testDir, 'multi-component-lock-ready');

      const blockedMs = await runSecretStoreRace(vaultDir, vaultDir, ready);

      expect(readSecrets(vaultDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
      expect(blockedMs).toBeGreaterThanOrEqual(200);
    }, 30_000);

    it('serializes a missing store across a symlinked ancestor after materialization', async () => {
      const realParent = path.join(testDir, 'real-parent');
      const aliasParent = path.join(testDir, 'alias-parent');
      fs.mkdirSync(realParent);
      fs.symlinkSync(realParent, aliasParent, 'dir');
      const holderVaultDir = path.join(aliasParent, 'missing-store');
      const writerVaultDir = path.join(realParent, 'missing-store');
      const ready = path.join(testDir, 'symlink-ancestor-lock-ready');

      const blockedMs = await runSecretStoreRace(holderVaultDir, writerVaultDir, ready);

      expect(fs.statSync(holderVaultDir).ino).toBe(fs.statSync(writerVaultDir).ino);
      expect(readSecrets(writerVaultDir)).toEqual({ CHILD_WRITER: 'child', PARENT_WRITER: 'parent' });
      expect(blockedMs).toBeGreaterThanOrEqual(200);
    }, 30_000);

    it('keeps one lock identity when secrets.env is atomically replaced', async () => {
      const vaultDir = path.join(testDir, 'replacement-vault');
      fs.mkdirSync(vaultDir);
      fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'INITIAL=original\n', { mode: 0o600 });

      const child = spawn(
        process.execPath,
        ['run', SECRETS_LOCK_HOLDER_HELPER, vaultDir, '400', 'file-replace'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: process.cwd(),
        },
      );
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      const childExit = new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}: ${stderr}`)));
        child.on('error', reject);
      });

      const replaced = path.join(vaultDir, 'secrets-replaced');
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(replaced)) {
        if (Date.now() >= deadline) throw new Error(`secret symlink replacement never completed: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const startedAt = Date.now();
      writeSecret(vaultDir, 'PARENT_WRITER', 'parent');
      const blockedMs = Date.now() - startedAt;
      await childExit;

      expect(fs.lstatSync(path.join(vaultDir, 'secrets.env')).isSymbolicLink()).toBe(false);
      expect(readSecrets(vaultDir)).toEqual({
        REPLACED_DURING_LOCK: 'preserved',
        CHILD_WRITER: 'child',
        PARENT_WRITER: 'parent',
      });
      expect(blockedMs).toBeGreaterThanOrEqual(200);
    }, 30_000);

    it('re-reads before a delete-all decision so a concurrent child entry survives', async () => {
      writeSecret(testDir, 'OLD', 'old');
      const child = spawn(
        process.execPath,
        ['run', SECRETS_LOCK_HOLDER_HELPER, testDir, '400', 'delete-race'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd: process.cwd(),
        },
      );
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      const childExit = new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}: ${stderr}`)));
        child.on('error', reject);
      });

      const ready = path.join(testDir, 'secrets-lock-ready');
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error(`secret lock holder never signalled readiness: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      deleteSecrets(testDir, ['OLD']);
      await childExit;
      expect(readSecrets(testDir)).toEqual({ CHILD_WRITER: 'child' });
    }, 30_000);
  });

  it('fails closed when asked to mutate an exact secrets.env symlink', () => {
    const vaultDir = path.join(testDir, 'symlink-mutation');
    fs.mkdirSync(vaultDir);
    const target = path.join(testDir, 'symlink-mutation-target.env');
    fs.writeFileSync(target, 'TARGET=preserved\n', { mode: 0o600 });
    fs.symlinkSync(target, path.join(vaultDir, 'secrets.env'));

    expect(readSecrets(vaultDir)).toEqual({ TARGET: 'preserved' });
    expect(() => writeSecret(vaultDir, 'NEW', 'blocked')).toThrow();
    expect(fs.readFileSync(target, 'utf-8')).toBe('TARGET=preserved\n');
    expect(fs.lstatSync(path.join(vaultDir, 'secrets.env')).isSymbolicLink()).toBe(true);
  });

  it('fails closed when asked to harden an exact secrets.env symlink', () => {
    const vaultDir = path.join(testDir, 'symlink-hardening');
    fs.mkdirSync(vaultDir);
    const target = path.join(testDir, 'symlink-hardening-target.env');
    fs.writeFileSync(target, 'TARGET=preserved\n', { mode: 0o644 });
    fs.symlinkSync(target, path.join(vaultDir, 'secrets.env'));
    const beforeMode = fs.statSync(target).mode & 0o777;

    expect(() => tightenSecretsPermissions(vaultDir)).toThrow(/non-regular secret store/);
    expect(fs.statSync(target).mode & 0o777).toBe(beforeMode);
    expect(fs.lstatSync(path.join(vaultDir, 'secrets.env')).isSymbolicLink()).toBe(true);
  });

  it('rejects invalid UTF-8 bytes instead of decoding replacement characters', () => {
    fs.writeFileSync(path.join(testDir, 'secrets.env'), Buffer.from([0x4b, 0x45, 0x59, 0x3d, 0xff, 0x0a]));
    expect(() => readSecrets(testDir)).toThrow(InvalidSecretValueError);
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

    it('is a non-materializing no-op when the secret directory does not exist', () => {
      const missingDir = path.join(testDir, 'missing-secret-scope');

      expect(() => loadSecrets(missingDir)).not.toThrow();
      expect(fs.existsSync(missingDir)).toBe(false);
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

    it('preserves values from an existing store when a later scope directory is missing', () => {
      const existingDir = path.join(testDir, 'existing-secret-scope');
      const missingDir = path.join(testDir, 'missing-secret-scope');
      const env = Object.create(null) as NodeJS.ProcessEnv;
      writeSecret(existingDir, 'EXISTING_API_KEY', 'preserved');

      loadLayeredSecrets([existingDir, missingDir], env);

      expect(env.EXISTING_API_KEY).toBe('preserved');
      expect(fs.existsSync(missingDir)).toBe(false);
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

    it.skipIf(!POSIX)('repairs an owner-owned mode-000 secret file before decoding it', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'REPAIRED=value\n', { mode: 0o600 });
      fs.chmodSync(secretsPath, 0o000);

      tightenSecretsPermissions(testDir);

      expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      expect(readSecrets(testDir)).toEqual({ REPAIRED: 'value' });
    });

    it.skipIf(!POSIX)('repairs an owner-owned mode-000 secret directory before decoding its file', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      fs.writeFileSync(secretsPath, 'REPAIRED=value\n', { mode: 0o600 });
      fs.chmodSync(testDir, 0o000);

      try {
        tightenSecretsPermissions(testDir);
        expect(fs.statSync(testDir).mode & 0o777).toBe(0o700);
        expect(readSecrets(testDir)).toEqual({ REPAIRED: 'value' });
      } finally {
        fs.chmodSync(testDir, 0o700);
      }
    });

    it.skipIf(!POSIX)('propagates a failed permission repair without changing secret bytes', () => {
      const secretsPath = path.join(testDir, 'secrets.env');
      const content = 'UNCHANGED=value\n';
      fs.writeFileSync(secretsPath, content, { mode: 0o644 });
      const originalChmod = fs.chmodSync.bind(fs);
      const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation((target, mode) => {
        if (path.resolve(String(target)) === path.resolve(secretsPath)) {
          throw Object.assign(new Error('injected chmod failure'), { code: 'EACCES' });
        }
        return originalChmod(target, mode);
      });

      try {
        expect(() => tightenSecretsPermissions(testDir)).toThrow('injected chmod failure');
      } finally {
        chmod.mockRestore();
      }

      expect(fs.readFileSync(secretsPath, 'utf-8')).toBe(content);
      expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o644);
    });

    it.skipIf(!POSIX || process.getuid === undefined)(
      'rejects an untrusted secret-file owner before chmod',
      () => {
        const secretsPath = path.join(testDir, 'secrets.env');
        fs.writeFileSync(secretsPath, 'UNTRUSTED=value\n', { mode: 0o644 });
        const originalLstat = fs.lstatSync.bind(fs);
        const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
          const stat = originalLstat(target, options);
          if (path.resolve(String(target)) !== path.resolve(secretsPath)) return stat;
          return new Proxy(stat, {
            get(actual, property, receiver) {
              if (property === 'uid') return process.getuid!() + 1;
              return Reflect.get(actual, property, receiver);
            },
          });
        }) as typeof fs.lstatSync);
        const chmod = vi.spyOn(fs, 'chmodSync');

        try {
          expect(() => tightenSecretsPermissions(testDir)).toThrow(/not owned/);
          expect(chmod.mock.calls.some(([target]) => (
            path.resolve(String(target)) === path.resolve(secretsPath)
          ))).toBe(false);
        } finally {
          chmod.mockRestore();
          lstat.mockRestore();
        }

        expect(fs.readFileSync(secretsPath, 'utf-8')).toBe('UNTRUSTED=value\n');
      },
    );

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

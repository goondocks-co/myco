import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWindowsLockRootFromProfile,
} from '@myco/utils/user-lock-root.js';
import {
  resolveWindowsNativeProfileWith,
  type WindowsKnownFolderApi,
} from '@myco/utils/windows-native-profile.js';

const HELPER = path.resolve('tests/helpers/user-lock-root-helper.ts');

function runHelper(env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(process.execPath, ['run', HELPER], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`user-lock-root helper exited ${code}: ${stderr}`));
      resolve((JSON.parse(stdout) as { lockRoot: string }).lockRoot);
    });
  });
}

describe('Windows per-user lock root', () => {
  it('builds the existing .myco lock location from a native profile path', () => {
    expect(resolveWindowsLockRootFromProfile('D:\\Profiles\\Chris'))
      .toBe('D:\\Profiles\\Chris\\.myco\\locks');
    expect(() => resolveWindowsLockRootFromProfile('relative\\profile')).toThrow();
    expect(() => resolveWindowsLockRootFromProfile('')).toThrow();
  });

  it.skipIf(process.platform !== 'win32')(
    'is identical across processes with divergent home-related environments',
    async () => {
      const firstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-win-home-a-'));
      const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-win-home-b-'));
      try {
        const base = { ...process.env, MYCO_HOME: 'C:\\Explicit\\SharedMycoHome' };
        const [first, second] = await Promise.all([
          runHelper({
            ...base,
            HOME: firstHome,
            USERPROFILE: firstHome,
            LOCALAPPDATA: path.join(firstHome, 'AppData', 'Local'),
          }),
          runHelper({
            ...base,
            HOME: secondHome,
            USERPROFILE: secondHome,
            LOCALAPPDATA: path.join(secondHome, 'AppData', 'Local'),
          }),
        ]);

        expect(first).toBe(second);
        expect(first.toLowerCase().endsWith('\\.myco\\locks')).toBe(true);
      } finally {
        fs.rmSync(firstHome, { recursive: true, force: true });
        fs.rmSync(secondHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function fakeKnownFolderApi(options: {
  initializeResult?: number;
  folderResult?: number;
  pointer?: bigint;
  content?: string;
} = {}): WindowsKnownFolderApi & { calls: string[] } {
  const calls: string[] = [];
  const encoded = [...(options.content ?? 'C:\\Users\\Native')].map((char) => char.charCodeAt(0));
  return {
    calls,
    initialize() {
      calls.push('initialize');
      return options.initializeResult ?? 0;
    },
    getProfilePath(_folderId, output) {
      calls.push('getProfilePath');
      output[0] = options.pointer ?? 0x1234n;
      return options.folderResult ?? 0;
    },
    readUtf16(_pointer, byteOffset) {
      return encoded[byteOffset / 2] ?? 0;
    },
    free(pointer) {
      calls.push(`free:${pointer}`);
    },
    uninitialize() {
      calls.push('uninitialize');
    },
  };
}

describe('Windows native profile resolver contract', () => {
  it('decodes the bounded UTF-16 profile and balances COM initialization', () => {
    const api = fakeKnownFolderApi({ content: 'D:\\Profiles\\Živa' });

    expect(resolveWindowsNativeProfileWith(api)).toBe('D:\\Profiles\\Živa');
    expect(api.calls).toEqual([
      'initialize',
      'getProfilePath',
      'free:4660',
      'uninitialize',
    ]);
  });

  it('frees a non-null result and uninitializes when the known-folder call fails', () => {
    const api = fakeKnownFolderApi({ folderResult: -2147467259 });

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/SHGetKnownFolderPath/);
    expect(api.calls).toEqual([
      'initialize',
      'getProfilePath',
      'free:4660',
      'uninitialize',
    ]);
  });

  it('proceeds after RPC_E_CHANGED_MODE without uninitializing another apartment', () => {
    const api = fakeKnownFolderApi({ initializeResult: -2147417850 });

    expect(resolveWindowsNativeProfileWith(api)).toBe('C:\\Users\\Native');
    expect(api.calls).not.toContain('uninitialize');
    expect(api.calls).toContain('free:4660');
  });

  it('rejects a null native result without an environment fallback', () => {
    const api = fakeKnownFolderApi({ pointer: 0n });

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/null profile path/);
    expect(api.calls).toEqual(['initialize', 'getProfilePath', 'uninitialize']);
  });

  it('bounds unterminated native UTF-16 output and still frees it', () => {
    const api = fakeKnownFolderApi();
    api.readUtf16 = () => 65;

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/not NUL-terminated/);
    expect(api.calls).toContain('free:4660');
    expect(api.calls).toContain('uninitialize');
  });
});

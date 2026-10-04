import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';
import { testPerUserLocksRoot } from '../helpers/per-user-lock-namespace.js';
import { withSandboxedNativeLockRoot } from '../helpers/sandbox-native-lock-root.js';

it('verifies the native lock provider exclusively against a runner-owned filesystem', () => {
  type Operation = (...args: unknown[]) => unknown;
  const filesystem = fs as unknown as Record<string, Operation>;
  const originals = new Map<string, Operation>();
  for (const name of ['mkdirSync', 'lstatSync', 'chmodSync']) {
    const original = filesystem[name]!;
    originals.set(name, original);
    filesystem[name] = function (this: unknown, target: unknown, ...args: unknown[]) {
      expect(typeof target).toBe('string');
      const relative = path.relative(process.env.MYCO_TEST_RUN_ROOT!, target as string);
      expect(relative).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(path.isAbsolute(relative)).toBe(false);
      return original.call(this, target, ...args);
    };
  }
  try {
    const selected = withSandboxedNativeLockRoot(testPerUserLocksRoot, resolvePerUserLocksDir);
    expect(path.isAbsolute(selected)).toBe(true);
    expect(fs.statSync(testPerUserLocksRoot).isDirectory()).toBe(true);
  } finally {
    for (const [name, original] of originals) filesystem[name] = original;
  }
});

it.skipIf(process.platform === 'win32' || !process.getuid)('fences an uninjected native lock mutation before filesystem access', () => {
  const native = path.join(path.sep, 'var', 'tmp', `myco-locks-${process.getuid!()}`);
  expect(() => fs.mkdirSync(native, { recursive: true })).toThrow('TEST SAFETY');
});

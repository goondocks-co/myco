import fs from 'node:fs';
import path from 'node:path';

type Operation = (...args: unknown[]) => unknown;

// Exercise native path selection and verification against a runner-owned filesystem fixture.
export function withSandboxedNativeLockRoot<T>(root: string, operation: () => T): T {
  const filesystem = fs as unknown as Record<string, Operation>;
  const originals = new Map<string, Operation>();
  for (const name of ['mkdirSync', 'lstatSync', 'chmodSync']) {
    const original = filesystem[name]!;
    originals.set(name, original);
    filesystem[name] = function (this: unknown, target: unknown, ...args: unknown[]) {
      const nativeLock = typeof target === 'string' && (
        path.basename(target) === `myco-locks-${process.getuid?.()}`
        || path.basename(target) === 'locks' && path.basename(path.dirname(target)) === '.myco'
      );
      return original.call(this, nativeLock ? root : target, ...args);
    };
  }
  try { return operation(); }
  finally { for (const [name, original] of originals) filesystem[name] = original; }
}

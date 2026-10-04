import path from 'node:path';

export function nativeLockRoots(): string[] {
  return process.platform !== 'win32' && process.getuid
    ? [path.join(path.sep, 'var', 'tmp', `myco-locks-${process.getuid()}`)] : [];
}

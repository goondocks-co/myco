/**
 * Temp paths a test helper made that live as long as the tests using them.
 * A helper registers each one here; the test preload
 * (tests/setup/sandbox-preload.ts) removes them all in its `afterAll`, which
 * Bun runs after every file's own hooks: once per file under --isolate, once
 * per process otherwise. A helper registering here needs no cleanup from its
 * callers, whichever hook or test they call it from.
 */
import fs from 'node:fs';

const registered: string[] = [];

/** Remove `target` (a file or a directory tree) once the tests using it are done. */
export function removeWhenTestsEnd(target: string): string {
  registered.push(target);
  return target;
}

/** Remove every registered path. Called by the test preload. */
export function removeRegisteredTestPaths(rm: typeof fs.rmSync = fs.rmSync): void {
  for (const target of registered.splice(0)) {
    try { rm(target, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

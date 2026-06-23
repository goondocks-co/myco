import fs from 'node:fs';

/**
 * Internal: `myco __finish-uninstall <dir>`. Spawned detached from a temp copy
 * of the binary (see `resolveOrchestratorBinary`) by `myco remove --purge` when
 * the managed install dir holds the running executable — a process cannot
 * delete its own running image on Windows. Retries until the parent `remove`
 * exits and releases the lock. Best-effort; never throws.
 */
export async function run(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch {
      /* parent still holds the running-exe lock — retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface FixtureAllocation {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
}
const allocations = new Map<string, FixtureAllocation>();

export function allocateOwnedFixture(prefix: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('Invalid fixture prefix');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const { dev, ino } = fs.lstatSync(root);
  allocations.set(root, Object.freeze({ root, dev, ino }));
  return root;
}

export function requireOwnedFixtureAllocation(target: string): FixtureAllocation {
  const allocation = [...allocations.values()].find(({ root }) => {
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (!allocation) throw new Error('TEST SAFETY: permission fixtures require an owned fixture allocation');
  const current = fs.lstatSync(allocation.root);
  if (!current.isDirectory() || current.dev !== allocation.dev || current.ino !== allocation.ino) {
    throw new Error('TEST SAFETY: permission fixture allocation identity changed');
  }
  return allocation;
}

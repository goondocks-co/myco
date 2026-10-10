import { it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { LocalVolume, volumeIdentity } from '@myco/server/local-volume.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';

it('allows its parent to interrupt one native create step', async () => {
  createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(process.env.MYCO_HOME!), step => {
    if (step !== process.env.MYCO_CREATE_STOP_AFTER) return;
    fs.writeFileSync(path.join(process.cwd(), 'reached'), process.env.MYCO_HOME!);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  if (process.env.MYCO_CREATE_STOP_AFTER === 'serve') {
    const paths = peekLocalPaths(process.env.MYCO_HOME!);
    await new LocalVolume(paths).serve({ pending: () => false, startup: () => {},
      identity: () => volumeIdentity(paths.databasePath, () => null), start: async () => {
        fs.writeFileSync(path.join(process.cwd(), 'reached'), process.env.MYCO_HOME!);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return { stop: async () => {} };
      } });
  }
}, 30_000);

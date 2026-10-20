import fs from 'node:fs';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';

const [mode, home, serverUrl, projectId, release] = process.argv.slice(2);
if (!home || !serverUrl || !projectId || !release || !['holder', 'writer'].includes(mode)) throw new Error('Invalid ledger appender arguments');
const ledger = new LegacyLedger(home, serverUrl, projectId);
if (mode === 'holder') {
  withFileLockSync(`${ledger.file}.lock`, () => {
    fs.writeSync(1, 'ready\n');
    const deadline = Date.now() + 10_000;
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw new Error('Ledger lock holder was not released');
      Atomics.wait(waiter, 0, 0, 10);
    }
  });
  ledger.append({ k: 'source', session: 'concurrent-deletion', from: 'deleted' });
} else {
  fs.writeSync(1, 'ready\n');
  ledger.append({ k: 'spore', id: 'concurrent-spore' });
}

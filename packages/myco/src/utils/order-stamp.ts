import fs from 'node:fs';
import path from 'node:path';
import { isReportOrder } from '@goondocks/myco-shared/report-order';
import { withFileLockSync } from './lifecycle-lock.js';
import { atomicWriteFileSync } from './atomic-write.js';

/** Issue an observation order under the reporting home's Deployment-scoped counter lock. */
export function issueReportOrder(home: string, deploymentKey: string, floor = 0): number {
  if (!/^[a-zA-Z0-9_-]+$/.test(deploymentKey)) throw new Error('invalid report Deployment key');
  if (floor !== 0 && !isReportOrder(floor)) throw new Error('invalid report order floor');
  const file = path.join(home, 'report-order', `${deploymentKey}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    let issued = 0;
    try {
      const stored: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isReportOrder(stored)) throw new Error('invalid stored report order');
      issued = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = Math.max(issued, floor) + 1;
    if (!isReportOrder(next)) throw new Error('report order exhausted');
    atomicWriteFileSync(file, JSON.stringify(next), { mode: 0o600, durable: true });
    return next;
  }, { create: true });
}

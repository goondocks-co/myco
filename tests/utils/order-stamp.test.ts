import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';
import { issueReportOrder } from '@myco/utils/order-stamp.js';

it('persists counter order across clocks and restarts, resyncs strictly above a floor and refuses corrupt or exhausted state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-report-order-'));
  try {
    expect(issueReportOrder(home, 'deployment')).toBe(1);
    expect(issueReportOrder(home, 'deployment')).toBe(2);
    expect(issueReportOrder(home, 'deployment', 100)).toBe(101);
    expect(issueReportOrder(home, 'other')).toBe(1);
    const file = path.join(home, 'report-order', 'deployment.json');
    fs.unlinkSync(file);
    expect(issueReportOrder(home, 'deployment', 101)).toBe(102);
    for (const invalid of ['broken', 'null', '-1', '"100"']) {
      fs.writeFileSync(file, invalid);
      expect(() => issueReportOrder(home, 'deployment')).toThrow();
    }
    fs.writeFileSync(file, String(Number.MAX_SAFE_INTEGER));
    expect(() => issueReportOrder(home, 'deployment')).toThrow('exhausted');
    expect(() => issueReportOrder(home, '../escape')).toThrow('Deployment key');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

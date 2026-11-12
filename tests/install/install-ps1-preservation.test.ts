import { describe, expect, it } from 'bun:test'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { beforeGa, PWSH, select } from './install-ps1-fixture.js';

describe('Windows installer preservation', () => {
  it.skipIf(PWSH === '' || process.platform === 'win32')('preserves stable-only legacy bytes and records their identity before replacement', () => {
    const run = select(beforeGa, { current: '1.4.8', replace: true, install: '2.0.0-beta.2' });
    expect(run.status).toBe(0);
    const record = JSON.parse(fs.readFileSync(path.join(run.mycoHome, 'legacy-executable.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(record).toMatchObject({ version: '1.4.8', replaced_at: run.exe });
    expect(fs.readFileSync(record.path)).toEqual(run.before!);
    expect(record.sha256).toBe(crypto.createHash('sha256').update(run.before!).digest('hex'));
    expect(fs.readFileSync(run.exe)).not.toEqual(run.before!);
  });

  it.skipIf(PWSH === '' || process.platform === 'win32')('aborts Windows replacement if the preservation copy fails', () => {
    const run = select(beforeGa, { current: '1.4.8', replace: true, install: '2.0.0-beta.2', failPreserve: true });
    expect(run.status).not.toBe(0); expect(run.out).toContain('Could not preserve');
    expect(fs.readFileSync(run.exe)).toEqual(run.before!);
    expect(fs.existsSync(path.join(path.dirname(run.exe), 'versions', '2.0.0-beta.2'))).toBe(false);
  });
});

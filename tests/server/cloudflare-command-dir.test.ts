import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peekCommandDir, peekDeploymentRecord } from '@myco/server/cloudflare.js';

it('peeks absent, legacy and current command directories without migrating or creating them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-command-dir-'));
  const root = path.join(home, 'server');
  const current = path.join(root, 'cloudflare');
  try {
    expect(peekCommandDir(home)).toBe(current);
    expect(fs.existsSync(root)).toBe(false);
    fs.mkdirSync(root);
    const legacy = path.join(root, 'cloudflare.json');
    fs.writeFileSync(legacy, JSON.stringify({ accountId: 'legacy-fixture' }));
    expect(peekCommandDir(home)).toBe(root);
    expect(peekDeploymentRecord(home)?.accountId).toBe('legacy-fixture');
    expect(fs.existsSync(current)).toBe(false);
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, 'record.json'), JSON.stringify({ accountId: 'current-fixture' }));
    expect(peekCommandDir(home)).toBe(current);
    expect(peekDeploymentRecord(home)?.accountId).toBe('current-fixture');
    expect(JSON.parse(fs.readFileSync(legacy, 'utf8')).accountId).toBe('legacy-fixture');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

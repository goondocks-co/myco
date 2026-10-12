import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureServerLayout } from '@myco/server/layout.js';

test('migrates only the managed Cloudflare record and leaves retired Compose files byte-identical', () => {
  const home = mkdtempSync(join(tmpdir(), 'myco-layout-'));
  const root = join(home, 'server');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const files = { 'compose.yaml': 'services: {}', '.env': 'MYCO_PORT=1', 'secrets/session_secret': 'fixture' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  writeFileSync(join(root, 'cloudflare.json'), '{"workerName":"kept"}');
  ensureServerLayout(home);
  ensureServerLayout(home);
  expect(existsSync(join(root, 'cloudflare.json'))).toBe(false);
  expect(readFileSync(join(root, 'cloudflare', 'record.json'), 'utf8')).toBe('{"workerName":"kept"}');
  for (const [name, text] of Object.entries(files)) expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  expect(existsSync(join(root, 'compose'))).toBe(false);
});

test('a present destination is never overwritten and a fresh home is unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'myco-layout-'));
  ensureServerLayout(home);
  expect(existsSync(join(home, 'server'))).toBe(false);
  mkdirSync(join(home, 'server', 'cloudflare'), { recursive: true });
  writeFileSync(join(home, 'server', 'cloudflare.json'), '{"workerName":"old"}');
  writeFileSync(join(home, 'server', 'cloudflare', 'record.json'), '{"workerName":"kept"}');
  ensureServerLayout(home);
  expect(readFileSync(join(home, 'server', 'cloudflare', 'record.json'), 'utf8')).toBe('{"workerName":"kept"}');
  expect(existsSync(join(home, 'server', 'cloudflare.json'))).toBe(true);
});

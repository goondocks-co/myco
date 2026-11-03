import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

test('member source has no user-session dependencies', () => {
  const root = path.resolve(import.meta.dir, '../../packages/myco/src');
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(0);
  const forbidden = /osascript|terminal-notifier|notify-send|security find-generic-password|node-keytar|keytar/;
  expect(files.filter(file => forbidden.test(fs.readFileSync(path.join(root, file), 'utf8')))).toEqual([]);
});

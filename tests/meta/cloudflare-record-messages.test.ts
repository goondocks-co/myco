import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve(import.meta.dir, '../../packages/myco/src');
const owner = path.join(sourceRoot, 'server/cloudflare.ts');

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

it('keeps missing Cloudflare record sentences in the shared message owner', () => {
  const customMessage = /no\s+(?:\w+\s+)*cloudflare\s+deployment\s+record|record exists on this machine/i;
  expect(sources(sourceRoot).filter(file => file !== owner && customMessage.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(sourceRoot, file))).toEqual([]);
});

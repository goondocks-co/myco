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

const customMessage = /no\s+(?:\w+\s+)*cloudflare\s+deployment\s+record\b|record exists on this machine/i;

it('keeps missing Cloudflare record sentences in the shared message owner', () => {
  expect(sources(sourceRoot).filter(file => file !== owner && customMessage.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(sourceRoot, file))).toEqual([]);
});

it('allows the absent-record status wording', () => {
  expect(customMessage.test('No Cloudflare Deployment recorded.')).toBe(false);
});

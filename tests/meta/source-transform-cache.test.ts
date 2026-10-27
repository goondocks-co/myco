import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript-v6';
import { sourceTransformCache } from '../helpers/source-transform-cache.js';
import { instrumentReadPreparations, type PreparationOrigin } from '../helpers/statement-recorder.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-transform-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const source = "export function read(db){return db.prepare('SELECT * FROM plans')}";
const origin: Extract<PreparationOrigin, { kind: 'exception' }> = {
  kind: 'exception', id: 'source-cache', file: 'probe.ts', owner: 'read', expression: "'SELECT * FROM plans'", phase: 'T', relations: ['plans'],
};

test('cached source retains preparation guards and refreshes changed policy and transformer inputs', () => {
  let calls = 0;
  const transform = (held: typeof origin) => { calls++; return instrumentReadPreparations(ts, source, 'probe.ts', [held], '/recorder.ts'); };
  const dependencies = [JSON.stringify(origin), 'transformer-one'];
  const first = sourceTransformCache(root, dependencies)('probe.ts', source, () => transform(origin));
  expect(first).toContain('"id":"source-cache"');
  expect(sourceTransformCache(root, dependencies)('probe.ts', source, () => transform(origin))).toBe(first);
  expect(calls).toBe(1);
  const changed: typeof origin = { ...origin, phase: 'P' };
  const refreshed = sourceTransformCache(root, [JSON.stringify(changed), dependencies[1]!])('probe.ts', source, () => transform(changed));
  expect(refreshed).toContain('"phase":"P"');
  expect(calls).toBe(2);
  sourceTransformCache(root, [JSON.stringify(changed), 'transformer-two'])('probe.ts', source, () => transform(changed));
  expect(calls).toBe(3);
});

test('source and file identity cannot reuse a transformed predecessor', () => {
  const cache = sourceTransformCache(root, ['transformer']);
  expect(cache('one.ts', 'one', () => 'guard-one')).toBe('guard-one');
  expect(cache('one.ts', 'two', () => 'guard-two')).toBe('guard-two');
  expect(cache('two.ts', 'two', () => 'guard-three')).toBe('guard-three');
});

test('a modified cached body is refused before it can replace instrumentation', () => {
  const cache = sourceTransformCache(root, ['transformer']);
  cache('one.ts', 'one', () => 'guarded');
  const file = path.join(root, fs.readdirSync(root)[0]!);
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  held.contents = 'unguarded';
  fs.writeFileSync(file, JSON.stringify(held));
  expect(() => cache('one.ts', 'one', () => 'guarded')).toThrow('Invalid source transform cache entry');
});

test('concurrent processes publish one complete identical cache entry', async () => {
  const module = pathToFileURL(path.resolve('tests/helpers/source-transform-cache.ts')).href;
  const script = `import {sourceTransformCache} from ${JSON.stringify(module)};sourceTransformCache(${JSON.stringify(root)},['transformer'])('one.ts','one',()=>'guarded');`;
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(sourceTransformCache(root, ['transformer'])('one.ts', 'one', () => { throw new Error('cache miss'); })).toBe('guarded');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
  }
});

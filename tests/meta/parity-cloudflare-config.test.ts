import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_TELEMETRY_ALIASES } from '../parity/targets/cloudflare.ts';

test('the parity dev session explicitly disables source watching', () => {
  const source = fs.readFileSync(new URL('../parity/targets/dev-session.mjs', import.meta.url), 'utf8');
  expect(source).toMatch(/dev:\s*\{[^}]*\bwatch:\s*false\b/);
});

test('every Worker telemetry import is covered by the parity diagnostic aliases', () => {
  const root = path.resolve(import.meta.dir, '../../packages/myco-server/src');
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const aliases = new Set<string>(PARITY_TELEMETRY_ALIASES);
  const imports = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .flatMap(file => transpiler.scanImports(fs.readFileSync(path.join(root, file), 'utf8'))
      .filter(entry => /(?:^|\/)telemetry\.[^/]+$/.test(entry.path))
      .map(entry => ({ file, specifier: entry.path })));
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter(entry => !aliases.has(entry.specifier))).toEqual([]);
});

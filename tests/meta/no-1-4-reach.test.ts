import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';
import { walk } from '../helpers/2-0-closure.ts';
import { LEGACY_DIRS, LEGACY_FILES } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages/myco/src');
const PREFIX = 'packages/myco/src/';
const TEXT_ONLY = [
  'runtime/bun-sqlite.d.ts',
  'skills/contamination.ts',
  'skills/names.ts',
  'symbionts/templates/cline/plugin.ts',
  'symbionts/templates/opencode/plugin.ts',
  'symbionts/templates/pi/plugin.ts',
];

it('the 1.4 boundary is empty on disk', () => {
  expect([...LEGACY_DIRS, ...LEGACY_FILES].filter(file => fs.existsSync(path.join(SRC, file)))).toEqual([]);
});

it('accounts for every surviving source module and opaque import', () => {
  const { myco, server } = walk();
  const loose = filesUnder(SRC).map(moduleKey).filter(key => !myco.modules.has(key)).map(key => key.slice(PREFIX.length)).sort();
  expect(loose).toEqual([...TEXT_ONLY].sort());
  expect(Object.fromEntries([...myco.unknowable, ...server.unknowable])).toEqual({
    'packages/myco/src/symbionts/templates.generated.ts': 4,
  });
});

it('rejects an import of a deleted runtime module', () => {
  expect(() => walk((file, text) => file.endsWith('/member/buffer.ts')
    ? "import '@myco/daemon/client.js';\n" + text : text)).toThrow('unresolvable alias import');
});

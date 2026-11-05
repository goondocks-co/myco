import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps pause and resume readers confined to frozen migrations', () => {
  const migrations = new Set(['db/schema-v102.ts', 'db/schema-v104.ts', 'db/schema-v110.ts', 'db/schema-v694.ts']);
  const readers = ['packages/myco-server/src', 'packages/myco-server/ui/src', 'packages/myco/src'].flatMap(root =>
    readdirSync(root, { recursive: true }).map(String)
      .filter(file => /\.tsx?$/.test(file) && !/\.generated\./.test(file) && !migrations.has(file))
      .map(file => join(root, file)))
    .filter(file => /learning_paused|learning_resumed_at|dispatchedBeforeResume/.test(readFileSync(file, 'utf8')));
  expect(readers).toEqual([]);
});

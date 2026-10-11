import { expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

it('keeps project capability SQL in settings, apart from schema and backup ownership', () => {
  const owners = new Set([
    'packages/myco-server/src/core/settings.ts',
    'packages/myco-server/src/db/schema.ts',
    'packages/myco-server/src/core/backup.ts',
  ]);
  expect(sources('packages/myco-server/src')
    .filter((path) => !owners.has(path) && /\bproject_capabilities\b/.test(readFileSync(path, 'utf8')))).toEqual([]);
});

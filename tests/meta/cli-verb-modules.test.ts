import { expect, it } from 'bun:test';
import path from 'node:path';
import { cliVerbModules, REPO_ROOT } from '../helpers/import-closure.ts';

const src = path.join(REPO_ROOT, 'packages/myco/src');
it('keeps every dispatched module including parent-relative hook and MCP entries', () => {
  const modules = cliVerbModules(src);
  expect(modules.has(path.join(src, 'hooks/entry.ts'))).toBe(true);
  expect(modules.has(path.join(src, 'mcp/stdio-bridge.ts'))).toBe(true);
  expect(modules.size).toBeGreaterThanOrEqual(53);
});

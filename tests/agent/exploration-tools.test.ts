import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExplorationTools } from '../../packages/myco/src/agent/tools/exploration-tools.js';

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myco-exploration-'));
  root = join(home, 'checkout');
  mkdirSync(root);
  writeFileSync(join(root, 'AGENTS.md'), 'Use committed source.\n');
  writeFileSync(join(home, 'outside.txt'), 'outside-private-marker');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), 'metadata-private-marker');
  symlinkSync(home, join(root, 'outside'), 'dir');
  symlinkSync(join(root, '.git'), join(root, 'metadata'), 'dir');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function call(name: string, args: Record<string, unknown>) {
  const tool = createExplorationTools({ projectRoot: root, ripgrepPath: 'rg' }).find((entry) => entry.name === name)!;
  const result = await tool.handler(args, {} as never);
  return JSON.parse(result.content[0].text);
}

describe('code exploration boundary', () => {
  it('rejects escaped paths and metadata through every file tool', async () => {
    for (const name of ['fs_read', 'fs_list', 'fs_tree', 'code_grep']) {
      for (const path of ['../outside.txt', 'outside/outside.txt', '.git/config', 'metadata/config']) {
        await expect(call(name, { path, pattern: 'private-marker' })).rejects.toThrow();
      }
    }
  });

  it('reads project instructions and internal symlinks without reading git metadata', async () => {
    symlinkSync(join(root, 'AGENTS.md'), join(root, 'rules.md'));
    expect((await call('fs_read', { path: 'rules.md' })).content).toBe('Use committed source.\n');
    expect((await call('fs_list', { include_hidden: true })).items.map((entry: { name: string }) => entry.name)).not.toContain('.git');
    expect((await call('fs_tree', { include_hidden: true, depth: 4 })).tree).not.toContain('config');
    expect((await call('code_grep', { pattern: 'private-marker', glob: '**/*' })).matches).toEqual([]);
    const result = await call('code_grep', { pattern: 'committed', glob: '*.md' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path).toBe('AGENTS.md');
  });

  it('bounds large file reads and preserves both ends', async () => {
    writeFileSync(join(root, 'large.txt'), 'start\n' + 'x'.repeat(2_000_000) + '\nend');
    const result = await call('fs_read', { path: 'large.txt', end_line: 2000 });
    expect(result.bytes_truncated).toBe(true);
    expect(result.content.startsWith('start\n')).toBe(true);
    expect(result.content.endsWith('\nend')).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThan(501_000);
  });

  it('surfaces failed directory reads instead of reporting an empty tree', async () => {
    await expect(call('fs_tree', { path: 'AGENTS.md' })).rejects.toThrow();
  });
});

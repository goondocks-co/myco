import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSourcePaths, gatherMapSource, mapSourceAdmission } from '@myco/canopy/map/source.js';
import { createExplorationTools } from '@myco/agent/tools/exploration-tools.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('keeps layered exclusions and rules while comparing same-size edits by content', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'map-source-'));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, 'src'));
  await mkdir(join(projectRoot, '.agents'));
  for (const [path, content] of Object.entries({
    'AGENTS.md': 'Read committed source.', 'src/CLAUDE.md': 'Module rules.', 'src/main.ts': 'first',
    '.gitignore': 'ignored.txt\n!.env\n', 'ignored.txt': 'ignored', '.env': 'private',
    '.agents/skill.md': 'managed', 'baseline.txt': 'baseline', 'custom.txt': 'custom',
  })) await writeFile(join(projectRoot, path), content);
  await symlink('/etc/passwd', join(projectRoot, 'outside'));
  const config = { projectRoot, defaultPatterns: ['baseline.txt'], userPatterns: ['custom.txt'] };
  const before = await gatherMapSource(config, new AbortController().signal);
  expect(before.files.map((file) => file.path)).toEqual(['.gitignore', 'AGENTS.md', 'src/CLAUDE.md', 'src/main.ts']);
  expect(before.rules.map((file) => file.path)).toEqual(['AGENTS.md', 'src/CLAUDE.md']);
  const tools = createExplorationTools({ projectRoot, admits: mapSourceAdmission(before) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.find((tool) => tool.name === name)!.handler(args as never, {});
    return JSON.parse(result.content[0].text);
  };
  await expect(call('fs_read', { path: '.env' })).rejects.toThrow('excluded');
  expect(JSON.stringify(await call('fs_list', { include_hidden: true }))).not.toContain('.env');
  expect(JSON.stringify(await call('fs_tree', { include_hidden: true }))).not.toContain('.agents');
  expect((await call('code_grep', { pattern: 'private', glob: '**/.env' })).matches).toEqual([]);
  await writeFile(join(projectRoot, 'src/main.ts'), 'other');
  const after = await gatherMapSource(config, new AbortController().signal);
  expect(after.inputHash).not.toBe(before.inputHash);
  expect(changedSourcePaths(before.files, after.files)).toEqual(['src/main.ts']);
  expect((await gatherMapSource(config, new AbortController().signal)).inputHash).toBe(after.inputHash);
});

it('includes additions and deletions in the affected source set', () => {
  expect(changedSourcePaths([{ path: 'removed', sha256: 'a' }, { path: 'kept', sha256: 'b' }], [
    { path: 'added', sha256: 'c' }, { path: 'kept', sha256: 'b' },
  ])).toEqual(['added', 'removed']);
});

import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@myco/cli/server.js';

async function invoke(args: string[], home: string) {
  const old = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...values) => { output.push(values.join(' ')); });
  const err = spyOn(console, 'error').mockImplementation((...values) => { output.push(values.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
  try { await run(args, { runner: { run: async () => { throw new Error('unexpected process launch'); } } }); }
  catch (error) { if (!(error instanceof Error) || !/^exit:[12]$/.test(error.message)) throw error; }
  finally { log.mockRestore(); err.mockRestore(); exit.mockRestore(); if (old === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = old; }
  return output.join('\n');
}

for (const verb of ['create', 'status', 'update', 'backup', 'restore', 'destroy', 'github-app']) {
  test(`${verb} refuses the retired Compose target with the native recovery command`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-compose-retired-'));
    expect(await invoke([verb, '--target', 'compose'], home)).toContain('myco server create --target local');
    expect(existsSync(join(home, 'server'))).toBe(false);
  });
}

for (const bundle of ['server/compose/compose.yaml', 'server/compose.yaml']) {
  test(`a held ${bundle} refuses implicit target selection without modifying it`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'myco-compose-retired-'));
    const file = join(home, bundle);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'services: fixture');
    const output = await invoke(['status'], home);
    expect(output).toContain(file);
    expect(output).toContain('--target local');
    expect(readFileSync(file, 'utf8')).toBe('services: fixture');
  });
}

test('rotate and adopt are retired and an empty home defaults to native status', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myco-compose-retired-'));
  for (const verb of ['rotate', 'adopt']) expect(await invoke([verb], home)).toContain('retired');
  expect(await invoke(['status'], home)).toContain('myco server create --target local');
});

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, codeOf, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';

const SERVER = path.join(REPO_ROOT, 'packages/myco-server/src');
const PREFIX = 'packages/myco-server/src/';

const SERVING_ENTRIES = ['index.ts', 'entry/bun.ts', 'platform/bun/server-main.ts'];
/** The CLI's command table: the operator commands it registers load bootstrap and recovery modules no serving entry reaches. */
const COMMAND_REGISTRY = path.join(REPO_ROOT, 'packages/myco/src/cli/command-registry.ts');

describe('server production reachability', () => {
  it('reaches every server module that runs code from a serving entry or a registered CLI command', () => {
    const reached = closureOf([...SERVING_ENTRIES.map((entry) => path.join(SERVER, entry)), COMMAND_REGISTRY]);
    const loose = filesUnder(SERVER)
      .filter((file) => !reached.modules.has(moduleKey(file)))
      .filter((file) => codeOf(fs.readFileSync(file, 'utf8'), file).trim() !== '')
      .map((file) => moduleKey(file).slice(PREFIX.length))
      .sort();
    expect(loose, 'unreachable server modules need a real consumer or removal').toEqual([]);
  });
});

it('the parser entry loads independently of status query initialization', () => {
  const run = Bun.spawnSync(
    [process.execPath, '--no-env-file', '-e', "await import('./packages/myco-server/src/ingest/parse.ts');"],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
});

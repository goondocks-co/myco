import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/tool.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL } from '@myco/member/credential.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { legacyFixtureHome } from '../setup/fixtures/legacy-home.ts';

let root: string;
let restore: () => void;
let written: string[];
let write: ReturnType<typeof spyOn>;
let server: ReturnType<typeof Bun.serve>;
let calls: unknown[];
let cwd: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tool-cli-'));
  restore = bindSandboxChildHome(root);
  cwd = process.cwd(); process.chdir(root);
  written = []; calls = [];
  write = spyOn(process.stdout, 'write').mockImplementation((chunk, ...args: unknown[]) => {
    written.push(String(chunk));
    const callback = args.find(arg => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    expect(request.headers.get('authorization')).toBe('Bearer ' + 'm'.repeat(43));
    const body = await request.json() as { id?: number; method: string; params?: unknown };
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'fixture_tool', inputSchema: { type: 'object' } }] };
    else {
      calls.push(body.params);
      const params = body.params as { name: string; arguments: unknown };
      result = params.name === 'unknown'
        ? { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] }
        : { content: [{ type: 'text', text: 'Display text' }], structuredContent: { result: params.arguments } };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  process.env[ENV_SERVER_URL] = 'http://127.0.0.1:' + server.port;
  process.env[ENV_MEMBER_TOKEN] = 'm'.repeat(43);
  process.env[ENV_PROJECT] = 'proj_fixture';
});
afterEach(() => {
  server.stop(true); write.mockRestore(); process.chdir(cwd);
  for (const key of [ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT]) delete process.env[key];
  restore(); process.exitCode = 0; fs.rmSync(root, { recursive: true, force: true });
});
const invoke = async (args: string[]) => {
  await run([...args, '--credential', 'env'], path.join(root, '.myco'));
  return JSON.parse(written.join(''));
};
it('lists Deployment tools as JSON', async () => {
  expect(await invoke(['list', '--json'])).toMatchObject({ ok: true, result: [{ name: 'fixture_tool' }] });
});
for (const file of [false, true]) it('calls a Deployment tool with ' + (file ? '@file' : 'inline') + ' input', async () => {
  fs.writeFileSync(path.join(root, 'input.json'), '{"project":"proj_fixture"}');
  expect(await invoke(['call', '--json', '--input', file ? '@' + path.join(root, 'input.json') : '{"project":"proj_fixture"}', 'fixture_tool']))
    .toEqual({ ok: true, tool: 'fixture_tool', result: { project: 'proj_fixture' } });
  expect(calls).toHaveLength(1);
});
it('flushes a large structured result before returning', async () => {
  const value = { text: 'x'.repeat(100_000) };
  expect((await invoke(['call', 'fixture_tool', '--input', JSON.stringify(value)])).result).toEqual(value);
});
for (const [input, code] of [['not json', 'invalid_json'], ['[]', 'invalid_input'], ['42', 'invalid_input']]) it('refuses invalid input ' + input, async () => {
  expect((await invoke(['call', 'fixture_tool', '--input', input])).error.code).toBe(code);
  expect(calls).toHaveLength(0);
});
it('treats null input as an empty argument object', async () => {
  expect((await invoke(['call', 'fixture_tool', '--input', 'null'])).result).toEqual({});
});
it('reports a missing input flag value', async () => {
  expect((await invoke(['call', 'fixture_tool', '--input'])).error.code).toBe('invalid_arguments');
});
for (const kind of ['empty', 'member', 'legacy']) it('refuses credential-less tools on a ' + kind + ' home', async () => {
  if (kind === 'member') {
    fs.mkdirSync(path.join(process.env.MYCO_HOME!, 'member'), { recursive: true });
    fs.writeFileSync(path.join(process.env.MYCO_HOME!, 'member', 'cutover.json'), '{}');
  }
  if (kind === 'legacy') process.env.MYCO_HOME = legacyFixtureHome(root).mycoHome;
  await run(['list', '--json'], path.join(root, '.myco'));
  const result = JSON.parse(written.join(''));
  expect(result.error.code).toBe(kind === 'member' ? 'member_home' : 'credential_required');
  expect(result.error.message).toContain('--credential registry');
  expect(result.error.message).toContain('myco member provision');
  if (kind === 'legacy') expect(result.error.message).toContain('myco cutover --dry-run');
  expect(calls).toHaveLength(0);
  expect(process.exitCode).toBe(1);
});

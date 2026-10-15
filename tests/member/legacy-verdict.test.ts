import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandVerdict, mcpVerdict, pluginFileVerdict } from '@myco/member/legacy-verdict.js';

let scratch: string;
let home: string;
let binary: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stale-verdict-'));
  home = path.join(scratch, 'deleted-install');
  binary = path.join(home, 'bin', 'myco');
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

for (const credential of ['', ' --credential registry']) it(`classifies a missing binary and home as stale${credential}`, () => {
  expect(commandVerdict(`"${binary}" hook stop${credential}`, [])).toBe('stale');
  expect(mcpVerdict({ command: binary, args: ['mcp', credential] }, [])).toBe('stale');
  expect(mcpVerdict({ command: [binary, 'mcp'], environment: { MYCO_HOME: home } }, [])).toBe('stale');
  expect(pluginFileVerdict(`// myco:member-plugin\nconst binary = "${binary}";`, [])).toBe('stale');
});

for (const present of ['home', 'binary'] as const) it(`keeps another installation foreign when its ${present} exists`, () => {
  fs.mkdirSync(home);
  if (present === 'binary') { fs.mkdirSync(path.dirname(binary)); fs.writeFileSync(binary, 'fixture'); }
  expect(commandVerdict(`${binary} hook stop`, [])).toBe('foreign');
  expect(mcpVerdict({ command: binary }, [])).toBe('foreign');
  expect(pluginFileVerdict(`// myco:plugin-marker\nconst binary = "${binary}";`, [])).toBe('foreign');
});

it('keeps bare and relative commands unchanged, and requires a named or managed home', () => {
  expect(commandVerdict('myco hook stop', [])).toBe('legacy');
  expect(mcpVerdict({ command: 'myco' }, [])).toBe('legacy');
  expect(mcpVerdict({ headersHelper: 'myco member mcp-headers' }, [])).toBe('foreign');
  expect(mcpVerdict({ headersHelper: 'myco member mcp-headers --credential registry' }, [])).toBe('member');
  expect(pluginFileVerdict(`// myco:plugin-marker\nconst binary = "${binary}"; const MYCO_HOME = ".";`, [])).toBe('foreign');
  expect(mcpVerdict({ command: 'myco', env: { MYCO_HOME: home } }, [])).toBe('foreign');
  expect(mcpVerdict({ command: './bin/myco', env: { MYCO_HOME: home } }, [])).toBe('foreign');
  expect(mcpVerdict({ command: path.join(scratch, 'unknown') }, [])).toBe('foreign');
  expect(mcpVerdict({ command: path.join(scratch, 'unknown'), env: { MYCO_HOME: home } }, [])).toBe('stale');
});

it('keeps a registration foreign when either named home still exists', () => {
  fs.mkdirSync(home);
  const missing = path.join(scratch, 'missing');
  expect(commandVerdict(`MYCO_HOME=${missing} ${binary} hook stop`, [])).toBe('foreign');
  expect(mcpVerdict({ command: path.join(missing, 'bin', 'myco'), env: { MYCO_HOME: home } }, [])).toBe('foreign');
  expect(pluginFileVerdict(`// myco:plugin-marker\nconst binary = "${missing}/bin/myco"; const MYCO_HOME = "${home}";`, [])).toBe('foreign');
});

it('recognizes a quoted plugin binary under a home with spaces and a versioned binary', () => {
  const missing = path.join(scratch, 'deleted install');
  for (const binary of [path.join(missing, 'bin', 'myco'), path.join(missing, 'bin', 'versions', '1.4.8', 'myco')]) {
    expect(commandVerdict(`"${binary}" hook stop`, [])).toBe('stale');
    expect(pluginFileVerdict(`// myco:plugin-marker\nconst binary = "${binary}";`, [])).toBe('stale');
  }
});

it('keeps an existing binary foreign even when its explicitly named home is gone', () => {
  const binary = path.join(scratch, 'myco');
  fs.writeFileSync(binary, 'fixture');
  expect(mcpVerdict({ command: binary, env: { MYCO_HOME: home } }, [])).toBe('foreign');
  expect(commandVerdict(`MYCO_HOME=${home} ${binary} hook stop`, [])).toBe('foreign');
});

for (const key of ['headersHelper', 'http_headers_helper']) it(`classifies a stale remote MCP ${key} command before member ownership`, () => {
  const entry = { url: 'https://other.invalid/mcp', [key]: `${binary} member mcp-headers --credential registry --server https://other.invalid` };
  expect(mcpVerdict(entry, [])).toBe('stale');
  fs.mkdirSync(home);
  expect(mcpVerdict(entry, [])).toBe('member');
});

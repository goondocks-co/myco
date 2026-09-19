/**
 * The Pi member extension against Pi's own callback contract (Pi 0.85:
 * `dist/core/extensions/types.d.ts`). Pi calls every handler as
 * `handler(event, ctx)`: the session's transcript is
 * `ctx.sessionManager.getSessionFile()`, the project is `ctx.cwd`, the prompt
 * is `event.prompt`, and a tool runs as `execute(toolCallId, params, …)` and
 * answers `{ content: [...] }`, throwing to report a failure.
 *
 * The rendered template is imported beside a stub `@sinclair/typebox` (Pi's
 * runtime supplies the real one) and driven with those shapes; a stub binary
 * records every hook and tool call the extension makes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';

const MEMBER_FLAG = Symbol.for('myco.member-extension');
const TOOLS = '[{"name":"myco_search","description":"search","inputSchema":{"type":"object","properties":{"query":{"description":"q"}}}},{"name":"myco_fail","description":"fails","inputSchema":{"type":"object","properties":{}}}]';

let dir: string;
let root: string;
let home: string;
let log: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pi-contract-')));
  root = path.join(dir, 'proj');
  home = path.join(dir, 'home');
  log = path.join(dir, 'binary.log');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(home, 'bin', 'myco'), [
    '#!/bin/sh',
    `printf '%s' "$*" >> '${log}'`,
    `if [ "$1" = hook ]; then printf ' stdin=' >> '${log}'; cat >> '${log}'; printf '{}'; fi`,
    `if [ "$1 $2" = "tool list" ]; then printf '%s' '${TOOLS}'; fi`,
    `if [ "$1 $2 $3" = "tool call myco_search" ]; then printf '{"ok":true,"result":{"hits":1}}'; fi`,
    `if [ "$1 $2 $3" = "tool call myco_fail" ]; then printf '{"ok":false,"error":{"message":"refused"}}'; fi`,
    `printf '\\n' >> '${log}'`,
  ].join('\n'), { mode: 0o755 });
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  delete (globalThis as Record<symbol, unknown>)[MEMBER_FLAG];
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The member extension as provisioned, importable beside a stub of the one package Pi supplies. */
async function loadExtension(): Promise<(pi: unknown) => void> {
  const manifest = loadManifests().find((m) => m.name === 'pi')!;
  const rendered = new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project', home).renderMemberPlugin('registry')!;
  const extensionDir = path.join(root, '.pi', 'extensions', 'myco');
  const typebox = path.join(extensionDir, 'node_modules', '@sinclair', 'typebox');
  fs.mkdirSync(typebox, { recursive: true });
  fs.writeFileSync(path.join(typebox, 'package.json'), '{"name":"@sinclair/typebox","type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(typebox, 'index.js'), 'export const Type = { Object: (p) => ({ type: "object", properties: p }), Optional: (s) => s, Any: (o) => ({ ...o }) };\n');
  const file = path.join(extensionDir, 'index.ts');
  fs.writeFileSync(file, rendered);
  return (await import(pathToFileURL(file).href)).default;
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const tools = new Map<string, { label?: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }>();
  return {
    handlers, tools,
    pi: {
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
      registerTool: (tool: { name: string; label?: string; execute: never }) => tools.set(tool.name, tool),
      sendMessage: () => {},
    },
  };
}

const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

describe('the Pi member extension under Pi\'s callback contract', () => {
  it('runs every hook verb from (event, ctx), with the transcript from ctx.sessionManager and the prompt from event.prompt', async () => {
    const factory = await loadExtension();
    const { handlers, pi } = fakePi();
    factory(pi);
    const transcript = path.join(dir, 'sessions', '2026-09-19T10-00-00-000Z_0192f1a2-3b4c-7d8e-9f00-112233445566.jsonl');
    const ctx = { cwd: root, sessionManager: { getSessionFile: () => transcript } };

    await handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
    await handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'hello pi', systemPrompt: '' }, ctx);
    await handlers.get('agent_end')!({ type: 'agent_end', messages: [] }, ctx);
    await handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, ctx);

    const hooks = calls().filter((line) => line.startsWith('hook '));
    expect(hooks.map((line) => line.split(' stdin=')[0])).toEqual([
      'hook session-start --symbiont pi --credential registry',
      'hook user-prompt-submit --symbiont pi --credential registry',
      'hook stop --symbiont pi --credential registry',
      'hook session-end --symbiont pi --credential registry',
    ]);
    for (const line of hooks) {
      const payload = JSON.parse(line.split(' stdin=')[1]!);
      expect(payload).toMatchObject({ transcript_path: transcript, session_id: '0192f1a2-3b4c-7d8e-9f00-112233445566', cwd: root });
    }
    expect(JSON.parse(hooks[1]!.split(' stdin=')[1]!).prompt).toBe('hello pi');
  });

  it('calls a tool with its params, not the call id, answers Pi\'s content shape, and throws when the tool refuses', async () => {
    const factory = await loadExtension();
    const { handlers, tools, pi } = fakePi();
    factory(pi);
    await handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, { cwd: root, sessionManager: { getSessionFile: () => undefined } });

    expect([...tools.keys()]).toEqual(['myco_search', 'myco_fail']);
    expect(tools.get('myco_search')!.label).toBe('myco_search');
    const answer = await tools.get('myco_search')!.execute('call-123', { query: 'why' }, undefined, undefined, {});
    expect(answer.content).toEqual([{ type: 'text', text: '{"hits":1}' }]);
    const toolCall = calls().find((line) => line.startsWith('tool call myco_search'))!;
    expect(toolCall).toContain('--input {"query":"why"}');
    expect(toolCall).not.toContain('call-123');
    await expect(tools.get('myco_fail')!.execute('call-124', {}, undefined, undefined, {})).rejects.toThrow('refused');
  });

  it('marks itself active for a global Myco extension only once registered with a runnable binary', async () => {
    const factory = await loadExtension();
    factory(fakePi().pi);
    expect((globalThis as Record<symbol, unknown>)[MEMBER_FLAG]).toBe(process.cwd());

    delete (globalThis as Record<symbol, unknown>)[MEMBER_FLAG];
    fs.rmSync(path.join(home, 'bin', 'myco'));
    factory(fakePi().pi);
    expect((globalThis as Record<symbol, unknown>)[MEMBER_FLAG]).toBeUndefined();
  });
});

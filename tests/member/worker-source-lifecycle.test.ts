import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { startClaudeSource } from '@myco/runner/drivers/claude-source-permission.js';
import { runGrant } from '@myco/runner/drivers/grant.js';
import { harnessById } from '@myco/runner/harnesses.js';
import { discardRunDir, writeRunDir } from '@myco/runner/mcp-config.js';
import { RUN_DIRECTORY_MANIFEST } from '@myco/runner/run-directory.js';
import { STOP_GRACE_MS } from '@myco/runner/process-group.js';
import { stubClaudeSource } from '../helpers/stub-claude-source.js';
import { processAlive } from '../support/process-alive.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const BOUND_MS = STOP_GRACE_MS * 3;
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('source cleanup exceeded its bound')), BOUND_MS); })]); }
  finally { clearTimeout(timer); }
}
const alive = (pid: number): boolean => processAlive(pid);

function fixture(id: 'claude-code' | 'opencode' | 'codex') {
  const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-source-lifecycle-')));
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { id: number; method: string };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
  } });
  const allocation = writeRunDir(root, 'run_source', { serverUrl: `http://127.0.0.1:${server.port}`, projectId: 'source_fixture', runToken: 'synthetic-run-token' });
  const repo = join(allocation.scratchDir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), 'source');
  const spec = { ...allocation, prompt: 'inspect source', credentialEnv: {}, sourceReadOnly: true };
  const bin = id === 'claude-code' ? stubClaudeSource(['{"type":"system","subtype":"init","session_id":"source_fixture"}'], [
    { tool_name: 'Read', tool_input: { file_path: join(repo, 'README.md') } },
    { tool_name: 'Read', tool_input: { file_path: spec.mcpConfigPath } },
  ]) : removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-source-harness-bin-')));
  const pidFile = join(bin, 'pids.json');
  const helperReady = join(bin, 'helper.pid');
  const helper = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(helperReady)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const ownership = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit'] });
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(helperReady)})) return;
  clearInterval(ready);
  fs.writeFileSync(${JSON.stringify(`${pidFile}.part`)}, JSON.stringify([process.pid, helper.pid]));
  fs.renameSync(${JSON.stringify(`${pidFile}.part`)}, ${JSON.stringify(pidFile)});
}, 10);
setInterval(() => {}, 1000);
`;
  if (id === 'claude-code') {
    const executable = join(bin, 'claude');
    writeFileSync(executable, readFileSync(executable, 'utf8').replace("const fs = require('node:fs');", `const fs = require('node:fs');\n${ownership}`).replace('process.exit(0);', 'return;'), { mode: 0o755 });
  } else {
    writeFileSync(join(bin, id), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(bin, 'cwd.txt'))}, process.cwd());
${ownership}
if (${JSON.stringify(id)} === 'codex') console.log(JSON.stringify({ type: 'thread.started', thread_id: 'source_fixture' }));
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'session/prompt' || message.id === undefined) return;
  const agent = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').default_agent;
  const result = message.method === 'initialize' ? { protocolVersion: 1 } : message.method === 'session/new' ? { sessionId: 'source_fixture', modes: { currentModeId: agent } } : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
`, { mode: 0o755 });
  }
  const pids = (): number[] => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) as number[] : [];
  return { spec, bin, repo, pids, ready: () => bounded((async () => { while (pids().length !== 2) await new Promise((resolve) => { setTimeout(resolve, 10); }); })()), cleanup: async () => {
    for (const pid of [...pids(), ...(existsSync(helperReady) ? [Number(readFileSync(helperReady, 'utf8'))] : [])]) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await server.stop(true);
  } };
}

describe('source containment with run process ownership', () => {
  for (const id of ['claude-code', 'opencode', 'codex'] as const) {
    for (const ending of ['return', 'abort', 'consumer exception'] as const) {
      it(`${id} keeps the allocation owned until source-mode ${ending} stops its group`, async () => {
        const f = fixture(id);
        const previousPath = process.env.PATH;
        process.env.PATH = `${f.bin}:${previousPath ?? ''}`;
        const stopping = new AbortController();
        const iterator = driverFor(id)!.run(f.spec, stopping.signal)[Symbol.asyncIterator]();
        try {
          const failure = new Error('source evidence write failed');
          const consume = async (): Promise<void> => {
            for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
              if (event.kind !== 'started') continue;
              await f.ready();
              expect(f.pids().map(alive)).toEqual([true, true]);
              const manifest = JSON.parse(readFileSync(join(f.spec.scratchDir, RUN_DIRECTORY_MANIFEST), 'utf8'));
              expect(manifest.processGroups).toContain(f.pids()[0]);
              expect(() => discardRunDir(f.spec.scratchDir)).toThrow('still has a harness owner');
              expect(readFileSync(join(f.bin, 'cwd.txt'), 'utf8')).toBe(id === 'codex' ? f.spec.scratchDir : f.repo);
              if (id === 'claude-code') expect(JSON.parse(readFileSync(join(f.bin, 'decisions.json'), 'utf8'))).toEqual(['allow', 'deny']);
              if (ending === 'consumer exception') throw failure;
              if (ending === 'abort') stopping.abort();
              break;
            }
          };
          if (ending === 'consumer exception') await expect(bounded(consume())).rejects.toBe(failure);
          else await bounded(consume());
          expect(f.pids().map(alive)).toEqual([false, false]);
          discardRunDir(f.spec.scratchDir);
          expect(existsSync(f.spec.scratchDir)).toBe(false);
        } finally {
          stopping.abort();
          await bounded(iterator.return!());
          await f.cleanup();
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
        }
      }, BOUND_MS * 3);
    }
  }

  it('disposes the source SDK and resolves exit without starting its line consumer', async () => {
    const f = fixture('claude-code');
    const previousPath = process.env.PATH;
    process.env.PATH = `${f.bin}:${previousPath ?? ''}`;
    const stopping = new AbortController();
    const started = await startClaudeSource(f.spec, runGrant(f.spec, harnessById('claude-code')!), process.env, stopping.signal);
    try {
      await f.ready();
      await bounded(started.dispose());
      expect(await bounded(started.exit)).toBe(-1);
      expect(f.pids().map(alive)).toEqual([false, false]);
    } finally {
      stopping.abort();
      await started.dispose();
      await f.cleanup();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, BOUND_MS * 3);

  it('releases its abort listener when SDK construction refuses ownership', async () => {
    const f = fixture('claude-code');
    const previousPath = process.env.PATH;
    process.env.PATH = `${f.bin}:${previousPath ?? ''}`;
    const stopping = new AbortController();
    const removed = spyOn(stopping.signal, 'removeEventListener');
    const manifest = join(f.spec.scratchDir, RUN_DIRECTORY_MANIFEST);
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), machineId: 'foreign-machine' }));
    try {
      await expect(startClaudeSource(f.spec, runGrant(f.spec, harnessById('claude-code')!), process.env, stopping.signal)).rejects.toThrow('belongs to another owner');
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(f.pids()).toEqual([]);
    } finally {
      stopping.abort();
      removed.mockRestore();
      await f.cleanup();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

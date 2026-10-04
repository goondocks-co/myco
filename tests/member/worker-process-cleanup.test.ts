import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverFor } from '@myco/runner/drivers/registry.js';
import { HARNESSES, offerable } from '@myco/runner/harnesses.js';
import { startHarness } from '@myco/runner/drivers/stream.js';
import { STOP_GRACE_MS } from '@myco/runner/process-group.js';
import type { RunEvent } from '@myco/runner/events.js';

const BOUND_MS = STOP_GRACE_MS * 3;

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('process cleanup exceeded its bound')), BOUND_MS); })]);
  } finally { clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  // An exited orphan can await the platform's reaper after its pipes have closed.
  return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
}

function fixture(id: string, leaveLeader: boolean): { dir: string; pids: () => number[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'myco-process-owner-'));
  const pidFile = join(dir, 'pids.json');
  const helperReady = join(dir, 'helper.pid');
  const helper = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(helperReady)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const script = join(dir, 'harness.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit'] });
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(helperReady)})) return;
  clearInterval(ready);
  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, helper.pid]));
  if (${JSON.stringify(id)} === 'claude-code') console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fixture_session' }));
  else if (${JSON.stringify(id)} === 'codex') console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture_session' }));
  if (${JSON.stringify(leaveLeader)}) process.exit(0);
}, 10);
if (!${JSON.stringify(leaveLeader)}) {
  setInterval(() => {}, 1000);
  let held = '';
  process.stdin.on('data', (chunk) => {
    held += chunk;
    let at;
    while ((at = held.indexOf('\\n')) >= 0) {
      const message = JSON.parse(held.slice(0, at)); held = held.slice(at + 1);
      if (message.method === 'session/prompt') continue;
      const agent = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').default_agent;
      const result = message.method === 'initialize' ? { protocolVersion: 1 } : message.method === 'session/new' ? { sessionId: 'fixture_session', modes: { currentModeId: agent } } : { stopReason: 'end_turn' };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }
  });
}
`);
  const harness = HARNESSES.find((entry) => entry.id === id)!;
  writeFileSync(join(dir, harness.binary), `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, { mode: 0o755 });
  const pids = (): number[] => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) as number[] : [];
  return { dir, pids, cleanup: () => {
    for (const pid of [...pids(), ...(existsSync(helperReady) ? [Number(readFileSync(helperReady, 'utf8'))] : [])]) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
  } };
}

async function ready(pids: () => number[]): Promise<void> {
  await bounded((async () => {
    while (pids().length !== 2) await new Promise((resolve) => { setTimeout(resolve, 10); });
  })());
  expect(pids().every(alive)).toBe(true);
}

describe('a harness process owner', () => {
  for (const harness of HARNESSES.filter(offerable)) {
    for (const ending of ['return', 'consumer exception', 'abort', 'leader exit'] as const) {
      it(`${harness.id} awaits leader and TERM-ignoring descendant cleanup on ${ending}`, async () => {
        const f = fixture(harness.id, ending === 'leader exit');
        const previousPath = process.env.PATH;
        process.env.PATH = `${f.dir}:${previousPath ?? ''}`;
        const server = Bun.serve({ port: 0, fetch: async (request) => {
          const body = await request.json() as { id: number; method: string };
          return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
        } });
        const config = join(f.dir, 'mcp.json');
        writeFileSync(config, JSON.stringify({ mcpServers: { myco: { url: `http://127.0.0.1:${server.port}/mcp`, headers: {} } } }));
        const stopping = new AbortController();
        const stream = driverFor(harness.id)!.run({ prompt: 'fixture', scratchDir: f.dir, mcpConfigPath: config, credentialEnv: {} }, stopping.signal);
        const iterator = stream[Symbol.asyncIterator]();
        try {
          if (ending === 'leader exit') {
            const events: RunEvent[] = [];
            await bounded((async () => { for await (const event of stream) events.push(event); })());
            expect(events.at(-1)?.kind).toBe('ended');
            expect(f.pids()).toHaveLength(2);
          } else if (ending === 'consumer exception') {
            const consumerError = new Error('fixture evidence write failed');
            async function consume(): Promise<void> {
              for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
                if (event.kind !== 'started') continue;
                await ready(f.pids);
                throw consumerError;
              }
            }
            await expect(bounded(consume())).rejects.toBe(consumerError);
          } else {
            let first = await bounded(iterator.next());
            while (!first.done && first.value.kind !== 'started') first = await bounded(iterator.next());
            expect(first.value?.kind).toBe('started');
            await ready(f.pids);
            if (ending === 'abort') {
              const drain = (async () => { while (!(await iterator.next()).done) { /* consume through process exit */ } })();
              stopping.abort();
              await bounded(drain);
            } else await bounded(iterator.return!());
          }
          expect(f.pids().map(alive)).toEqual([false, false]);
        } finally {
          stopping.abort();
          f.cleanup();
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
          await server.stop(true);
        }
      }, BOUND_MS * 3);
    }
  }

  it('stops a TERM-ignoring helper on leader exit before its inherited pipes close', async () => {
    const f = fixture('claude-code', true);
    const stopping = new AbortController();
    const started = startHarness(join(f.dir, 'claude'), [], { cwd: f.dir, env: {}, signal: stopping.signal });
    try {
      const lines: string[] = [];
      await bounded((async () => { for await (const line of started.lines) lines.push(line); })());
      expect(await bounded(started.exit)).toBe(0);
      expect(lines).toHaveLength(1);
      expect(f.pids().map(alive)).toEqual([false, false]);
    } finally { stopping.abort(); f.cleanup(); }
  }, BOUND_MS * 2);

  it('honors an already aborted signal without waiting for a stream consumer', async () => {
    const f = fixture('claude-code', false);
    const stopping = new AbortController();
    stopping.abort();
    const started = startHarness(join(f.dir, 'claude'), [], { cwd: f.dir, env: {}, signal: stopping.signal });
    try { expect(await bounded(started.exit)).not.toBe(0); } finally { f.cleanup(); }
  }, BOUND_MS * 2);

  it('awaits process cleanup when its line iterator is returned directly', async () => {
    const f = fixture('claude-code', false);
    const stopping = new AbortController();
    const started = startHarness(join(f.dir, 'claude'), [], { cwd: f.dir, env: {}, signal: stopping.signal });
    const lines = started.lines[Symbol.asyncIterator]();
    try {
      expect((await bounded(lines.next())).done).toBe(false);
      await bounded(lines.return!());
      expect(f.pids().map(alive)).toEqual([false, false]);
    } finally { stopping.abort(); f.cleanup(); }
  }, BOUND_MS * 2);
});

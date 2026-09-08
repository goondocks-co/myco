/**
 * Each driver run against its harness's real stream, and the protocol client
 * run against a real peer.
 *
 * The mapping a driver does is the thing under test, so these feed the driver's
 * own code rather than restating the mapping here: a test that re-implements
 * the translation asserts its own arithmetic and passes while the driver is
 * wrong. The native drivers read line-delimited JSON, so a stub binary that
 * writes recorded bytes exercises the whole path; the protocol driver speaks to
 * a peer over pipes, so a peer written here answers it.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeDriver } from '@myco/runner/drivers/claude-code.js';
import { codexDriver } from '@myco/runner/drivers/codex.js';
import { jsonLines } from '@myco/runner/drivers/stream.js';
import { writeRunDir } from '@myco/runner/mcp-config.js';
import { runWorker } from '@myco/runner/loop.js';
import { readFileSync } from 'node:fs';
import { turnOver, type Channel } from '@myco/runner/drivers/acp.js';
import type { RunEvent } from '@myco/runner/events.js';

const CONNECTION = { serverUrl: 'https://deployment.example', projectId: 'proj_1', runToken: 'tok_run_secret' };

/** A stub on PATH that writes these lines and exits with this status, in place of a harness. */
function stubHarness(name: string, lines: readonly string[], exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
  const path = join(dir, name);
  const body = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join('\n');
  writeFileSync(path, `#!/bin/sh\n${body}\nexit ${exitCode}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return dir;
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function runDir(): { scratchDir: string; mcpConfigPath: string } {
  return writeRunDir(mkdtempSync(join(tmpdir(), 'myco-run-')), 'run_1', CONNECTION);
}

describe('reading a harness stream into run events', () => {
  it('reads whole lines from a stream that arrives in pieces, and skips what is not an object', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield '{"type":"a"}';
      yield '\nnot json\n{"type":';
      yield '"b"}\n[1,2]\n';
    }
    const seen: unknown[] = [];
    async function* lines(): AsyncIterable<string> {
      let held = '';
      for await (const chunk of chunks()) {
        held += chunk;
        let at = held.indexOf('\n');
        while (at >= 0) { const line = held.slice(0, at).trim(); held = held.slice(at + 1); if (line.length > 0) yield line; at = held.indexOf('\n'); }
      }
      if (held.trim().length > 0) yield held.trim();
    }
    for await (const value of jsonLines(lines())) seen.push(value);
    // A line that is not JSON, and a JSON array, are both passed over.
    expect(seen).toEqual([{ type: 'a' }, { type: 'b' }]);
  });
});

describe('the Claude Code driver', () => {
  const RESULT_SUCCESS = '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","structured_output":null,"total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":2}}';

  it('reads a session, a message and a success whose structured output is null', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","message":{"content":"working on it"}}',
      RESULT_SUCCESS,
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['started', 'message', 'usage', 'ended']);
    expect(events[0]).toEqual({ kind: 'started', harness: 'claude-code', sessionId: 'sess_9' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    // A present-but-null structured output is a success, read by value.
    expect(events[2]).toEqual({ kind: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.5 });
  });

  it('reads an in-band error on a message as the end of the run', async () => {
    const dir = stubHarness('claude', [
      '{"type":"system","subtype":"init","session_id":"sess_9"}',
      '{"type":"assistant","error":"authentication_failed","message":{"content":""}}',
    ], 1);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'authentication_failed' });
  });

  it('reads a harness that wrote no result at all as a failure, never as a success', async () => {
    const dir = stubHarness('claude', ['{"type":"system","subtype":"init","session_id":"s"}'], 3);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(claudeCodeDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('exited 3'); }
  });
});

describe('the Codex driver', () => {
  it('reads an error item as an item and completes the turn anyway', async () => {
    const dir = stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i0","type":"error","message":"a tool was unavailable"}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":28,"output_tokens":5}}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    // The error item does not end the turn and does not fail the run.
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(events.find((e) => e.kind === 'usage')).toEqual({ kind: 'usage', inputTokens: 28, outputTokens: 5, costUsd: null });
  });

  it('reads a failed turn as a failure', async () => {
    const dir = stubHarness('codex', [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.failed","error":{"message":"the model refused"}}',
    ]);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const events = await collect(codexDriver.run({ ...runDir(), prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'error', detail: 'the model refused' });
  });

  it('writes the run\'s server into a configuration home of its own, so a host\'s own servers are out of reach', async () => {
    const dir = stubHarness('codex', ['{"type":"turn.completed","usage":{}}']);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    const run = runDir();
    await collect(codexDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    const written = readFileSync(join(run.scratchDir, 'codex-home', 'config.toml'), 'utf8');
    expect(written).toContain('[mcp_servers.myco]');
    expect(written).toContain('https://deployment.example/mcp');
    expect(written).toContain(CONNECTION.runToken);
  });
});

/** A peer that answers the protocol, in place of a harness binary. */
function peer(answer: (method: string, id: number) => string | null): { channel: Channel; close: () => void; asked: string[] } {
  const asked: string[] = [];
  let read: ((line: string) => void) | null = null;
  let closed: (() => void) | null = null;
  const channel: Channel = {
    write: (line) => {
      const message = JSON.parse(line) as { id: number; method: string };
      asked.push(message.method);
      const reply = answer(message.method, message.id);
      if (reply !== null) queueMicrotask(() => read?.(reply));
    },
    onLine: (fn) => { read = fn; },
    onClose: (fn) => { closed = fn; },
  };
  return { channel, close: () => closed?.(), asked };
}

describe('the agent-protocol driver', () => {
  it('opens a session naming the run\'s server, prompts once, and answers the turn\'s stop reason', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      if (method === 'initialize') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } })}\n`;
      if (method === 'session/new') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess_acp' } })}\n`;
      if (method === 'session/prompt') return `${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`;
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => ''));
    expect(events[0]).toEqual({ kind: 'started', harness: 'opencode', sessionId: 'sess_acp' });
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });
    expect(p.asked).toEqual(['initialize', 'session/new', 'session/prompt', 'session/close']);
  });

  it('answers a stop reason the protocol does not name as a failure', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => `${JSON.stringify({ jsonrpc: '2.0', id, result: method === 'session/prompt' ? { stopReason: 'something_else' } : { sessionId: 's' } })}\n`);
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'stderr said this'));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('stderr said this'); }
  });

  it('ends the run when the harness dies mid-turn rather than waiting on an answer that cannot come', async () => {
    const spec = { ...runDir(), prompt: 'do it', credentialEnv: {} };
    const p = peer((method, id) => {
      // The peer answers the handshake and then goes away without answering the prompt.
      if (method === 'session/prompt') { queueMicrotask(() => { p.close(); }); return null; }
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's' } })}\n`;
    });
    const events = await collect(turnOver(p.channel, 'opencode', spec, () => 'it exited 137'));
    const last = events.at(-1)!;
    expect(last.kind).toBe('ended');
    if (last.kind === 'ended') { expect(last.stop).toBe('error'); expect(last.detail).toContain('closed the connection'); }
  });
});

describe('the run credential a driver launches under', () => {
  it('reaches the run\'s own files and never a command line or a stream a log would carry', async () => {
    // A stub that writes back everything a process list and a log would show,
    // so the assertion is over what the launch actually did rather than over
    // what the driver meant to do.
    const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
    const seen = join(dir, 'seen.txt');
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(seen)}\nenv >> ${JSON.stringify(seen)}\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'\n`, { mode: 0o755 });
    chmodSync(join(dir, 'claude'), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;

    const run = runDir();
    const events = await collect(claudeCodeDriver.run({ ...run, prompt: 'do it', credentialEnv: {} }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ kind: 'ended', stop: 'end_turn', detail: null });

    // The token is in the run's own configuration and in nothing the harness
    // was handed on its command line or in its environment.
    expect(readFileSync(run.mcpConfigPath, 'utf8')).toContain(CONNECTION.runToken);
    const handed = readFileSync(seen, 'utf8');
    expect(handed).not.toContain(CONNECTION.runToken);
    expect(handed).toContain(run.mcpConfigPath);
  });
});

/** A stub `claude` that writes a result after a delay, so a run lasts long enough to be renewed. */
function slowHarness(ms: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nsleep ${(ms / 1000).toFixed(2)}\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'\n`, { mode: 0o755 });
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}

describe('the cadence a worker keeps', () => {
  // A fallback far above the answered wait but well under the test's own bound,
  // so ignoring the answer fails on elapsed time with a message rather than on
  // a timeout with none.
  const FALLBACK_MS = 3_000;
  const ANSWERED_POLL_MS = 20;

  it('waits what the Deployment answered, not the fallback it was constructed with', async () => {
    const asked: string[] = [];
    const stopping = new AbortController();
    let polls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      asked.push(new URL(url).pathname);
      if (url.endsWith('/worker/claim')) {
        polls += 1;
        if (polls >= 3) stopping.abort();
        return new Response(JSON.stringify({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: ANSWERED_POLL_MS }), { status: 200 });
      }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const started = Date.now();
    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok',
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl, signal: stopping.signal,
    });
    const elapsed = Date.now() - started;
    expect(asked.filter((p) => p === '/worker/claim').length).toBe(3);
    // Two waits at the answered cadence, against two at the fallback.
    expect({ elapsed: elapsed < FALLBACK_MS, polls: 3 }).toEqual({ elapsed: true, polls: 3 });
  }, 15_000);

  it('renews at the cadence the claim answered, so a run is held while it is driven', async () => {
    const HEARTBEAT_MS = 60;
    const RUN_MS = 400;
    process.env.PATH = `${slowHarness(RUN_MS)}:${process.env.PATH ?? ''}`;
    const stopping = new AbortController();
    let renewals = 0;
    let ended: Record<string, unknown> | null = null;
    let claims = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.endsWith('/worker/claim')) {
        claims += 1;
        return new Response(JSON.stringify({
          persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS,
          run: {
            projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it',
            harness: 'claude-code', runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 300,
          },
        }), { status: 200 });
      }
      if (url.endsWith('/worker/lease')) { renewals += 1; return new Response(JSON.stringify({ persisted: true, held: true, expiresAt: 0 }), { status: 200 }); }
      if (url.endsWith('/worker/end')) { ended = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ persisted: true, ended: true }), { status: 200 }); }
      return new Response(JSON.stringify({ persisted: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await runWorker({
      serverUrl: 'https://deployment.example', token: 'tok',
      runRoot: mkdtempSync(join(tmpdir(), 'myco-worker-')),
      once: true, pollIdleMs: FALLBACK_MS, log: () => {}, fetchImpl, signal: stopping.signal,
    });

    // A run driven for RUN_MS is renewed at the answered cadence. A worker
    // keeping a cadence of its own renews once or not at all across that span.
    expect({ claims, renewed: renewals >= 2, ended }).toEqual({
      claims: 1, renewed: true,
      ended: { projectId: 'proj_1', runId: 'run_1', status: 'completed', error: null },
    });
  }, 15_000);
});

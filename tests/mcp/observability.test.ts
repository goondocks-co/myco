/**
 * MCP daemon-side observability tests.
 *
 * Closes #288 — every /mcp tool dispatch must leave at least one log
 * entry, so `grep mcp <daemon.log>` is no longer empty after the agent
 * calls a tool. Mirrors the existing `hooks.*` log shape.
 *
 * Drives the real `createMcpProtocolServer` (no transport, no HTTP)
 * with a tiny in-memory logger and a tiny in-memory tool surface that
 * lets us trigger both happy and error paths deterministically.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Logger } from '@myco/daemon/logger.js';
import { createMcpProtocolServer } from '@myco/mcp/server.js';
import type { MycoTools } from '@myco/tools/index.js';

interface CapturedLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeRecordingLogger(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const push = (level: CapturedLogEntry['level']) => (kind: string, message: string, data?: Record<string, unknown>) => {
    entries.push({ level, kind, message, data });
  };
  return {
    entries,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}

function makeFakeTools(overrides: Partial<MycoTools> = {}): MycoTools {
  return {
    listTools: async () => [
      { name: 'fake_tool', description: 'fake', inputSchema: { type: 'object' } },
    ],
    callTool: async (name: string) => {
      if (name === 'fake_tool') return { ok: true };
      throw new Error('unknown tool');
    },
    ...overrides,
  } as unknown as MycoTools;
}

async function connectAndCall(tools: MycoTools, loggerOpts: { logger: Logger; sessionId?: string }) {
  const server = createMcpProtocolServer(tools, loggerOpts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP server observability (#288)', () => {
  let recording: ReturnType<typeof makeRecordingLogger>;

  beforeEach(() => {
    recording = makeRecordingLogger();
  });

  it('logs an info entry on successful tool dispatch', async () => {
    const { client } = await connectAndCall(makeFakeTools(), {
      logger: recording.logger,
      sessionId: 'sess-test-1',
    });

    await client.callTool({ name: 'fake_tool', arguments: {} });

    const calls = recording.entries.filter((e) => e.kind === 'mcp.call');
    expect(calls.length).toBeGreaterThanOrEqual(2); // received + completed

    const received = calls.find((e) => e.message === 'MCP tool call received');
    expect(received?.level).toBe('info');
    expect(received?.data).toMatchObject({ tool_name: 'fake_tool', session_id: 'sess-test-1' });

    const completed = calls.find((e) => e.message === 'MCP tool call completed');
    expect(completed?.level).toBe('info');
    expect(completed?.data).toMatchObject({
      tool_name: 'fake_tool',
      session_id: 'sess-test-1',
      status: 'ok',
    });

    await client.close();
  });

  it('logs a warn entry on tool error with error class + first line of message', async () => {
    const throwingTools = makeFakeTools({
      callTool: async () => { throw new TypeError('first line\nsecond line should not appear'); },
    });
    const { client } = await connectAndCall(throwingTools, {
      logger: recording.logger,
      sessionId: 'sess-test-2',
    });

    // The SDK surfaces the throw as a JSON-RPC error; the call from the
    // client will reject — that's expected and not what we're testing.
    await client.callTool({ name: 'anything', arguments: {} }).catch(() => undefined);

    const errorEntry = recording.entries.find((e) => e.level === 'warn' && e.kind === 'mcp.call');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.data).toMatchObject({
      tool_name: 'anything',
      session_id: 'sess-test-2',
      status: 'error',
      error_class: 'TypeError',
      error_message: 'first line',
    });
    expect((errorEntry?.data?.error_message as string).includes('\n')).toBe(false);

    await client.close();
  });

  it('logs listTools at debug level (lower verbosity than dispatches)', async () => {
    const { client } = await connectAndCall(makeFakeTools(), { logger: recording.logger });

    await client.listTools();

    const listEntries = recording.entries.filter((e) => e.kind === 'mcp.list');
    expect(listEntries.length).toBe(1);
    expect(listEntries[0].level).toBe('debug');
    expect(listEntries[0].data).toMatchObject({ tool_count: 1 });

    await client.close();
  });

  it('runs without a logger (observability is opt-in, not required)', async () => {
    // No logger supplied — must not throw, must still serve tool calls.
    const { client } = await connectAndCall(makeFakeTools(), { logger: undefined as unknown as Logger });
    const result = await client.callTool({ name: 'fake_tool', arguments: {} });
    expect(result).toBeDefined();
    await client.close();
  });
});

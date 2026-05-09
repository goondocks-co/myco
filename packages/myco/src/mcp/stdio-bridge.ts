/**
 * Stdio MCP entry point.
 *
 * This subprocess does NOT run an MCP server. It is a transparent JSON-RPC
 * pump between two MCP-SDK transports: a `StdioServerTransport` facing the
 * agent (claude-code, cursor, vscode-copilot, gemini, etc.) and a
 * `StreamableHTTPClientTransport` facing the daemon's in-process MCP server
 * at `/mcp`. Tool execution happens in the daemon — the same path that codex
 * already uses over native HTTP. There is one tool runtime, regardless of
 * what wire format an agent speaks.
 *
 * Each MCP-SDK transport exposes `start`, `send(message)`, `close`,
 * `onmessage`, `onclose`, `onerror`. Wiring `downstream.onmessage` to
 * `upstream.send` (and vice versa) gives us a transparent JSON-RPC proxy: the
 * agent's `initialize`, `tools/list`, `tools/call`, progress notifications,
 * and SSE-delivered responses all flow through unmodified.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { DaemonClient } from '../hooks/client.js';
import { requestContextFromEnvironment, requestContextHeaders } from '../tools/request-context.js';

const STDIO_BRIDGE_TAG = '[myco stdio-bridge]';

function logErr(msg: string): void {
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  process.stderr.write(`${STDIO_BRIDGE_TAG} ${msg}\n`);
}

export async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();
  const client = new DaemonClient(vaultDir);

  const ready = await client.ensureRunning();
  const info = client.getInfo();
  if (!ready || !info) {
    logErr('daemon failed to start; cannot bridge stdio MCP');
    process.exit(1);
  }

  const upstream = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    {
      requestInit: {
        headers: requestContextHeaders(requestContextFromEnvironment(process.env, vaultDir)),
      },
    },
  );
  const downstream = new StdioServerTransport();

  // Transparent JSON-RPC pump. The agent and the daemon's MCP server
  // negotiate `initialize`, capabilities, and protocol version directly
  // through this pipe; the bridge never interprets payloads.
  downstream.onmessage = (msg) => {
    upstream.send(msg).catch((err: Error) => logErr(`upstream send failed: ${err.message}`));
  };
  upstream.onmessage = (msg) => {
    downstream.send(msg).catch((err: Error) => logErr(`downstream send failed: ${err.message}`));
  };

  // When either side closes, tear down the other and exit.
  downstream.onclose = () => {
    void upstream.close().finally(() => process.exit(0));
  };
  upstream.onclose = () => {
    void downstream.close().finally(() => process.exit(0));
  };

  downstream.onerror = (err) => logErr(`downstream: ${err.message}`);
  upstream.onerror = (err) => logErr(`upstream: ${err.message}`);

  await upstream.start();
  await downstream.start();
}

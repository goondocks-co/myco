/**
 * The run credential's only home.
 *
 * A run's credential reaches a file and a process environment, and nothing
 * else. It is never in a prompt, never on a command line a process list would
 * show, and never in a log: a harness reads it from the configuration written
 * here, and the file lives in the run's own scratch directory and goes when the
 * run does.
 *
 * The server it names is the Deployment's MCP surface, and the three headers
 * are the three the Deployment requires of any caller: the credential, the
 * protocol the caller speaks, and the Project the run belongs to. What that
 * credential may then do is the run's own allowlist, decided at the Deployment.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER } from '../member/constants.js';

/** The name a harness sees for the Deployment's tools. */
export const MCP_SERVER_NAME = 'myco';

export interface RunConnection {
  serverUrl: string;
  projectId: string;
  runToken: string;
}

/** The configuration a harness reads, as the agent clients all spell an HTTP MCP server. */
export function mcpConfigOf(connection: RunConnection): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: new URL('/mcp', connection.serverUrl).toString(),
        headers: {
          authorization: `Bearer ${connection.runToken}`,
          [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL),
          [PROJECT_HEADER]: connection.projectId,
        },
      },
    },
  };
}

/**
 * Write a run's scratch directory and its MCP configuration.
 *
 * The directory is the run's alone and the file is readable only by the user
 * the worker runs as. Both go with `discardRunDir` when the run ends, whatever
 * the run's outcome.
 */
export function writeRunDir(root: string, runId: string, connection: RunConnection): { scratchDir: string; mcpConfigPath: string } {
  const scratchDir = join(root, runId);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const mcpConfigPath = join(scratchDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigOf(connection), null, 2), { mode: 0o600 });
  chmodSync(mcpConfigPath, 0o600);
  return { scratchDir, mcpConfigPath };
}

/** Remove a run's directory and the credential it holds. */
export function discardRunDir(scratchDir: string): void {
  rmSync(scratchDir, { recursive: true, force: true });
}

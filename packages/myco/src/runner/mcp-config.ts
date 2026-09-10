/**
 * The run's scratch directory: the run credential's only home, and the run's
 * instructions file.
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
 *
 * The instructions file is the Deployment's standing rules for the run, written
 * under the names harnesses read project instructions from in their working
 * directory, so the rules hold on every turn and the prompt carries only the
 * ask. The agent protocol carries user prompts alone, which is why the rules
 * travel as a file rather than as a second message.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberHeaders } from '../member/constants.js';

/** The name a harness sees for the Deployment's tools. */
export const MCP_SERVER_NAME = 'myco';

/** The names a run's instructions file is written under: one body, under each name a harness reads its working directory's instructions from. */
export const RUN_INSTRUCTIONS_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

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
        headers: memberHeaders({ token: connection.runToken, projectId: connection.projectId }),
      },
    },
  };
}

/**
 * Write a run's scratch directory: its MCP configuration, and its instructions
 * file where the claim handed one.
 *
 * The directory is the run's alone and the configuration is readable only by
 * the user the worker runs as. Everything in it goes with `discardRunDir` when
 * the run ends, whatever the run's outcome.
 */
export function writeRunDir(root: string, runId: string, connection: RunConnection, instructions: string | null = null): { scratchDir: string; mcpConfigPath: string } {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new Error('Invalid run directory identity.');
  const scratchDir = mkdtempSync(join(root, `${runId}-`));
  try {
    const mcpConfigPath = join(scratchDir, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigOf(connection), null, 2), { mode: 0o600 });
    chmodSync(mcpConfigPath, 0o600);
    if (instructions !== null && instructions.trim() !== '') {
      for (const name of RUN_INSTRUCTIONS_FILES) writeFileSync(join(scratchDir, name), instructions, { mode: 0o600 });
    }
    return { scratchDir, mcpConfigPath };
  } catch (error) {
    discardRunDir(scratchDir);
    throw error;
  }
}

/** Remove a run's directory and the credential it holds. */
export function discardRunDir(scratchDir: string): void {
  rmSync(scratchDir, { recursive: true, force: true });
}

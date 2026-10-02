/**
 * Which of Myco's tools an agent-protocol call names, as the harness's manifest declares its calls name them
 * (`runner.worker.mycoCalls`).
 *
 * The protocol gives a call no tool name of its own, only a kind, a title and its input. A harness names an MCP tool
 * in one of those: the title spelling the server and the tool (`mcp__myco__myco_run`, `myco_myco_run`), or the input
 * naming the server and the tool apart. A call names one of Myco's tools only where the name is one of the tools Myco's
 * server listed for the run, compared whole; the title is never kept. The grant (`acp-permission.ts`) and the step log
 * (`acp-events.ts`) both read a call through this, so a call allowed as Myco's is the call the log names as Myco's.
 */
import { getAtPath } from '@goondocks/myco-shared/dot-path';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import type { MycoCallNames } from '../harnesses.js';
import { stringOf } from './stream.js';

/** The one of `tools` this call names, or null; a harness that declares no naming names none. */
export function mycoToolNamed(toolCall: Record<string, unknown>, tools: ReadonlySet<string>, declared: MycoCallNames | undefined): string | null {
  if (declared === undefined || tools.size === 0) return null;
  if (declared.input !== undefined) {
    const server = getAtPath(toolCall, declared.input.server);
    const tool = getAtPath(toolCall, declared.input.tool);
    if (server === MCP_SERVER_NAME && typeof tool === 'string' && tools.has(tool)) return tool;
  }
  const name = stringOf(toolCall.name) ?? stringOf(toolCall.title);
  if (name === null) return null;
  for (const tool of tools) if (declared.names.some((form) => form.replace('{tool}', tool) === name)) return tool;
  return null;
}

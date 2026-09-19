/**
 * The member's hook block, derived from a symbiont's own hook template — the
 * one emitter behind both the `member-project` install scope (which writes it)
 * and `myco settings` (which prints it), so a provisioned laptop and a
 * provisioned sandbox can only differ in the credential source they declare.
 *
 * Two edits to the template: every command carries `--credential <source>`,
 * and the hook that never drains (PreToolUse) is not registered at all — the
 * member injects nothing before a tool call, so registering it would spend a
 * process per tool use to do nothing.
 */
import { CREDENTIAL_FLAG, NEVER_DRAINS_HOOK, SERVER_FLAG, hookNameInCommand, type CredentialSource } from '../member/constants.js';
import { deploymentUrl } from '../member/registry.js';
import { MCP_PATH } from '../plugins/spec.js';

/** Every hook command in a rendered or unrendered template, in document order. */
export function hookCommands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(hookCommands);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  if (typeof record.command === 'string') return [record.command];
  return Object.values(record).flatMap(hookCommands);
}

/** One hook entry or matcher group, or null when nothing in it survives for the member. */
function memberEntry(value: unknown, source: CredentialSource): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') {
    if (hookNameInCommand(record.command) === NEVER_DRAINS_HOOK) return null;
    return { ...record, command: `${record.command} ${CREDENTIAL_FLAG} ${source}` };
  }
  if (Array.isArray(record.hooks)) {
    const hooks = record.hooks.map((hook) => memberEntry(hook, source)).filter((hook) => hook !== null);
    return hooks.length > 0 ? { ...record, hooks } : null;
  }
  return null;
}

/**
 * The member block for `template`. Throws when the template's nesting is one
 * this emitter does not understand: a silently dropped hook is capture the
 * member would never take, so the shape is asserted rather than assumed.
 */
export function memberHookTemplate(template: Record<string, unknown>, source: CredentialSource): Record<string, unknown> {
  const block: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(template)) {
    const groups = (Array.isArray(value) ? value : [value]).map((group) => memberEntry(group, source)).filter((group) => group !== null);
    if (groups.length > 0) block[event] = Array.isArray(value) ? groups : groups[0];
  }
  const expected = hookCommands(template).filter((command) => hookNameInCommand(command) !== NEVER_DRAINS_HOOK).length;
  const emitted = hookCommands(block).length;
  if (emitted !== expected) {
    throw new Error(`Refusing to emit member hooks: the template declares ${expected} member hook commands but this shape emits ${emitted}`);
  }
  return block;
}

/**
 * The member's MCP server block for `template`: the same stdio launcher the
 * project install writes, with `--credential <source>` appended to its
 * arguments so the bridge it spawns reaches the Deployment over the member
 * credential. A server whose launcher is neither an `args` list nor a
 * `command` list is refused rather than written without the flag.
 */
export function memberMcpTemplate(template: Record<string, unknown>, source: CredentialSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(template)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error(`Refusing to emit a member MCP server: ${name} is not an object`);
    const server = { ...(def as Record<string, unknown>), ...MEMBER_MCP_LEVERS };
    if (Array.isArray(server.args)) out[name] = { ...server, args: [...server.args, CREDENTIAL_FLAG, source] };
    else if (Array.isArray(server.command)) out[name] = { ...server, command: [...server.command, CREDENTIAL_FLAG, source] };
    else throw new Error(`Refusing to emit a member MCP server: ${name} declares no argument list to carry ${CREDENTIAL_FLAG} ${source}`);
  }
  return out;
}

/** The `myco` arguments that print a member's MCP request headers as a JSON object. */
export const MCP_HEADERS_ARGS: readonly string[] = ['member', 'mcp-headers'];

/** What a server URL may contain to ride unquoted in a headers-helper command line. */
const SHELL_SAFE_URL = /^[A-Za-z0-9:/._~%-]+$/;

/**
 * The member's remote MCP server entry: the Deployment's `/mcp` URL and, under
 * the host's headers-helper key, the command that prints the member headers
 * for `source`. The command names the same Deployment the URL does, and prints
 * nothing for a membership on any other, so a stale entry never sends one
 * Deployment's bearer to another. The token is never written — the host runs
 * the command when it connects and after a 401, so a rotated token reaches it
 * without a restart.
 */
export function memberRemoteMcp(
  serverUrl: string,
  helperKey: string,
  binaryPath: string,
  source: CredentialSource,
): Record<string, unknown> {
  const server = deploymentUrl(serverUrl);
  if (!SHELL_SAFE_URL.test(server)) throw new Error(`Refusing to emit a member MCP server: ${server} cannot ride unquoted in a headers-helper command`);
  const helper = [binaryPath, ...MCP_HEADERS_ARGS, CREDENTIAL_FLAG, source, SERVER_FLAG, server].join(' ');
  return { url: `${server}${MCP_PATH}`, [helperKey]: helper };
}

/**
 * What a member's MCP entry declares beyond its launcher.
 *
 * `alwaysLoad` keeps the tools in front of the agent. A host that defers a
 * server until a tool search names it will not surface memory to an agent that
 * does not already know to look for it, and an agent that does not know the
 * project cannot know to search. The cost is a connection at session start,
 * which is what the bridge's start-up health probe is for.
 */
export const MEMBER_MCP_LEVERS: Readonly<Record<string, unknown>> = { alwaysLoad: true };

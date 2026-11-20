import { getAtPath, parseDotPath } from './dot-path.js';

export interface ToolResultDeclaration {
  failure: { from: 'record' | 'result'; path: string; equals: boolean } | null;
  evidence: string;
  commandOutput?: { tools: string[]; path: string };
}

export class ToolResultDeclarationInvalid extends Error {
  constructor() { super('Tool result declaration is unsupported'); this.name = 'ToolResultDeclarationInvalid'; }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

/** Admits one manifest-owned failure flag or its explicit absence and evidence. */
export function assertToolResultDeclaration(_agent: string, value: unknown): asserts value is ToolResultDeclaration {
  const refuse = (): never => { throw new ToolResultDeclarationInvalid(); };
  if (!object(value)) refuse();
  const declaration = value as Record<string, unknown>;
  if (Object.keys(declaration).some(key => !['failure', 'evidence', 'commandOutput'].includes(key)) || !text(declaration.evidence)) refuse();
  if (declaration.commandOutput !== undefined) {
    const output = declaration.commandOutput;
    if (!object(output) || !text(output.path) || !Array.isArray(output.tools) || !output.tools.every(text)
      || Object.keys(output).some(key => key !== 'tools' && key !== 'path')) refuse();
  }
  if (declaration.failure === null) return;
  if (!object(declaration.failure)) refuse();
  const failure = declaration.failure as Record<string, unknown>;
  if (Object.keys(failure).some(key => !['from', 'path', 'equals'].includes(key))
    || (failure.from !== 'record' && failure.from !== 'result') || !text(failure.path) || typeof failure.equals !== 'boolean') refuse();
  try { if (parseDotPath(failure.path as string).length === 0) refuse(); } catch { refuse(); }
}

/** Selects the failure declaration carried by the agent's generated capture bundle. */
export function toolResultDeclarationOf(bundles: readonly { name: string; toolResult?: ToolResultDeclaration }[], agent: string): ToolResultDeclaration | undefined {
  return bundles.find(bundle => bundle.name === agent)?.toolResult;
}

/** Reads only the manifest-declared flag; absent flags do not report failure. */
export function toolResultFailed(request: { declaration: ToolResultDeclaration | undefined; record?: unknown; result?: unknown; toolName?: string }): boolean {
  assertToolResultDeclaration('', request.declaration);
  const { failure } = request.declaration;
  if (failure !== null && getAtPath(request[failure.from], failure.path) === failure.equals) return true;
  const command = request.declaration.commandOutput;
  if (command === undefined || request.toolName === undefined || !command.tools.includes(request.toolName)) return false;
  const output = getAtPath(request.result, command.path);
  if (typeof output !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(output);
    if (object(parsed)) return (typeof parsed.exit_code === 'number' && parsed.exit_code !== 0) || parsed.isError === true;
  } catch { /* Command output can use the harness's labelled text envelope. */ }
  const exit = /^Process exited with code (-?\d+)\s*$/m.exec(output.split('\nOutput:')[0]!);
  return exit !== null && Number(exit[1]) !== 0;
}

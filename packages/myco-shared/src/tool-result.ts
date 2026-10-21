import { getAtPath, parseDotPath } from './dot-path.js';

export interface ToolResultDeclaration {
  failure: { from: 'record' | 'result'; path: string; equals: boolean };
  evidence: string;
}

export class ToolResultDeclarationInvalid extends Error {
  constructor() { super('Tool result declaration is unsupported'); this.name = 'ToolResultDeclarationInvalid'; }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');

/** Admits one manifest-owned failure flag and its evidence. */
export function assertToolResultDeclaration(_agent: string, value: unknown): asserts value is ToolResultDeclaration {
  const refuse = (): never => { throw new ToolResultDeclarationInvalid(); };
  if (!object(value)) refuse();
  const declaration = value as Record<string, unknown>;
  if (Object.keys(declaration).some(key => key !== 'failure' && key !== 'evidence') || !text(declaration.evidence) || !object(declaration.failure)) refuse();
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
export function toolResultFailed(request: { declaration: ToolResultDeclaration | undefined; record?: unknown; result?: unknown }): boolean {
  assertToolResultDeclaration('', request.declaration);
  const { failure } = request.declaration;
  return getAtPath(request[failure.from], failure.path) === failure.equals;
}

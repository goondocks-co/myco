/**
 * Argument validation for a tool call, against the definition's `inputSchema`.
 *
 * The same checks the member-side dispatcher applies (`packages/myco/src/tools/index.ts`
 * `validateInput`): required keys present and non-null, enum membership, JSON
 * type, and array items. A definition's schema is plain JSON Schema data, so
 * nothing is compiled per request.
 */
import type { JsonSchemaProperty, ToolDefinition } from './definitions.js';

export type ToolInput = Record<string, unknown>;

/** A failure the caller can act on, carried to the wire as a JSON-RPC error with `data.code`. */
export class ToolError extends Error {
  constructor(readonly code: 'invalid_input' | 'unknown_tool' | 'not_served' | 'tool_call_failed', message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** The arguments as an object; absent arguments are an empty object, anything else is refused. */
export function normalizeInput(args: unknown): ToolInput {
  if (args === undefined || args === null) return {};
  if (typeof args === 'object' && !Array.isArray(args)) return args as ToolInput;
  throw new ToolError('invalid_input', 'Tool arguments must be a JSON object');
}

export function validateInput(definition: ToolDefinition, input: ToolInput): void {
  for (const key of definition.inputSchema.required ?? []) {
    if (input[key] === undefined || input[key] === null) {
      throw new ToolError('invalid_input', `Missing required argument '${key}' for tool ${definition.name}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const property = definition.inputSchema.properties[key];
    if (!property || value === undefined) continue;
    validateProperty(definition.name, key, value, property);
  }
}

function validateProperty(tool: string, key: string, value: unknown, property: JsonSchemaProperty): void {
  if (value === null) {
    throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected ${expected(property)}`);
  }
  if (property.enum && !property.enum.includes(value)) {
    throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected one of ${property.enum.map(String).join(', ')}`);
  }
  const types = typeof property.type === 'string' ? [property.type] : property.type ?? [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    throw new ToolError('invalid_input', `Invalid argument '${key}' for tool ${tool}: expected ${expected(property)}`);
  }
  if (types.includes('array') && property.items && Array.isArray(value)) {
    value.forEach((item, index) => validateProperty(tool, `${key}[${index}]`, item, property.items!));
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

function expected(property: JsonSchemaProperty): string {
  if (property.enum) return `one of ${property.enum.map(String).join(', ')}`;
  if (typeof property.type === 'string') return property.type;
  if (property.type) return property.type.join(' or ');
  return 'a valid value';
}

/**
 * Gate: the tools the Deployment serves are the tools the member side declares.
 *
 * The seven definitions in `packages/myco/src/tools/definitions.ts` are what
 * every skill and agent has learned; the server serves the same names, the same
 * schemas and the same descriptions, minus the retired Grove pivot and with one
 * named difference — the `project_id` description, which speaks of a Deployment
 * rather than a Grove. A second difference fails here by name.
 *
 * The registry is held complete against each tool's op enum: every op is served
 * or named as not served with the issue that delivers it, and no op is served
 * that the definition does not declare.
 */
import { describe, expect, it } from 'bun:test';
import { TOOL_DEFINITIONS as MEMBER_DEFINITIONS } from '@myco/tools/definitions.js';
import { SERVED_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { NO_OP, TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';

/** The one property whose description the server words for a Deployment. */
const EXCEPTED = 'project_id';
const RETIRED = 'grove_id';

const byName = <T extends { name: string }>(defs: readonly T[]): Map<string, T> => new Map(defs.map((d) => [d.name, d]));

/** A member definition as the server must serve it: the Grove pivot gone, the excepted description taken from the server. */
function expected(member: (typeof MEMBER_DEFINITIONS)[number], server: (typeof TOOL_DEFINITIONS)[number]) {
  const { [RETIRED]: _retired, ...properties } = member.inputSchema.properties as Record<string, Record<string, unknown>>;
  if (properties[EXCEPTED] !== undefined) {
    properties[EXCEPTED] = { ...properties[EXCEPTED], description: (server.inputSchema.properties[EXCEPTED] as { description: string }).description };
  }
  return { ...member, inputSchema: { ...member.inputSchema, properties } };
}

const opsOf = (def: { inputSchema: { properties: Record<string, unknown> } }): string[] | null => {
  const op = def.inputSchema.properties.op as { enum?: readonly unknown[] } | undefined;
  return op?.enum ? op.enum.filter((v): v is string => typeof v === 'string') : null;
};

describe('tool parity', () => {
  it('serves exactly the catalogued tools, and the member side declares every one of them', () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([...SERVED_TOOLS].sort());
    const member = byName(MEMBER_DEFINITIONS);
    expect(TOOL_DEFINITIONS.filter((d) => !member.has(d.name)).map((d) => d.name)).toEqual([]);
  });

  it('serves each definition as the member side declares it, minus the Grove pivot, with the project_id description as the only worded difference', () => {
    const member = byName(MEMBER_DEFINITIONS);
    for (const server of TOOL_DEFINITIONS) {
      expect({ tool: server.name, definition: server }).toEqual({ tool: server.name, definition: expected(member.get(server.name)!, server) });
      expect({ tool: server.name, retired: RETIRED in server.inputSchema.properties }).toEqual({ tool: server.name, retired: false });
    }
  });

  it('words the excepted description for a Deployment, not a Grove', () => {
    for (const server of TOOL_DEFINITIONS) {
      const description = (server.inputSchema.properties[EXCEPTED] as { description?: string } | undefined)?.description;
      if (description === undefined) continue;
      expect({ tool: server.name, grove: /grove/i.test(description) }).toEqual({ tool: server.name, grove: false });
    }
  });

  it('keys the registry by the catalogue, both ways', () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...SERVED_TOOLS].sort());
  });

  it('serves or names every op each tool declares, and no op it does not', () => {
    for (const def of TOOL_DEFINITIONS) {
      const entry = TOOL_REGISTRY[def.name];
      const declared = opsOf(def);
      if (declared === null) {
        expect({ tool: def.name, defaultOp: entry.defaultOp, ops: Object.keys(entry.ops) }).toEqual({ tool: def.name, defaultOp: null, ops: [NO_OP] });
        continue;
      }
      expect({ tool: def.name, ops: Object.keys(entry.ops).sort() }).toEqual({ tool: def.name, ops: [...declared].sort() });
      expect({ tool: def.name, defaultDeclared: entry.defaultOp !== null && declared.includes(entry.defaultOp) }).toEqual({ tool: def.name, defaultDeclared: true });
    }
  });

  it('names an issue, or never, on every op it does not serve', () => {
    for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
      for (const [op, value] of Object.entries(entry.ops)) {
        if ('handler' in value) continue;
        expect({ tool, op, named: /^#\d+$/.test(value.notServed) || value.notServed === 'never' }).toEqual({ tool, op, named: true });
      }
    }
  });
});

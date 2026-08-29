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
import { EXTERNAL_TOOL_ALLOWLIST as MEMBER_ALLOWLIST, isAllowedExternalCall } from '@myco/mcp/external-surface.js';
import { SERVED_TOOLS, type ServedTool } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { EXTERNAL_PROJECT_ID_DESCRIPTION, EXTERNAL_TOOL_ALLOWLIST, EXTERNAL_TOOLS, externalDefinitions, isExternalCall } from '@myco-server-worker/mcp/external.js';
import { NO_OP, TOOL_REGISTRY, opOf } from '@myco-server-worker/mcp/registry.js';

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

  it('serves the external surface the member side declares: the same (tool, op) allowlist, every entry a registry key, and the listed definitions exactly the allowlisted names', () => {
    const entries = (list: Readonly<Record<string, ReadonlySet<string>>>) => Object.entries(list).map(([tool, ops]) => [tool, [...ops].sort()]).sort();
    expect(entries(EXTERNAL_TOOL_ALLOWLIST)).toEqual(entries(MEMBER_ALLOWLIST));
    for (const [tool, ops] of Object.entries(EXTERNAL_TOOL_ALLOWLIST)) {
      expect({ tool, served: (SERVED_TOOLS as readonly string[]).includes(tool) }).toEqual({ tool, served: true });
      const entry = TOOL_REGISTRY[tool as ServedTool];
      for (const op of ops) expect({ tool, op, keyed: op === NO_OP ? entry.defaultOp === null && NO_OP in entry.ops : op in entry.ops }).toEqual({ tool, op, keyed: true });
    }
    expect(externalDefinitions().map((d) => d.name).sort()).toEqual([...EXTERNAL_TOOLS].sort());
    const served = byName(TOOL_DEFINITIONS);
    for (const d of externalDefinitions()) {
      const op = d.inputSchema.properties.op as { enum?: readonly unknown[] } | undefined;
      const offered = op?.enum === undefined ? null : [...op.enum].sort();
      expect({ tool: d.name, offered }).toEqual({ tool: d.name, offered: op?.enum === undefined ? null : [...EXTERNAL_TOOL_ALLOWLIST[d.name]].sort() });
      const pivot = d.inputSchema.properties.project_id as { description?: string } | undefined;
      expect({ tool: d.name, pivot: pivot?.description ?? null }).toEqual({ tool: d.name, pivot: pivot === undefined ? null : EXTERNAL_PROJECT_ID_DESCRIPTION });
      const rest = (def: (typeof TOOL_DEFINITIONS)[number]) => {
        const { op: _op, project_id: _pivot, ...properties } = def.inputSchema.properties as Record<string, unknown>;
        return { ...def, inputSchema: { ...def.inputSchema, properties } };
      };
      expect({ tool: d.name, rest: rest(d) }).toEqual({ tool: d.name, rest: rest(served.get(d.name)!) });
    }
  });

  it('judges a call by the op the registry resolves, agreeing with the member surface on every declared op and on an omitted one, and refusing an empty op the member surface reads as the default', () => {
    const judged = (tool: ServedTool, args: Record<string, unknown>) => isExternalCall(tool, opOf(tool, args));
    const table: Array<[ServedTool, Record<string, unknown>]> = [
      ['myco_search', { query: 'x' }], ['myco_cortex', { op: 'digest' }], ['myco_cortex', {}], ['myco_plans', { op: 'list' }], ['myco_plans', {}],
      ['myco_plans', { op: 'get', id: 'p1' }], ['myco_sessions', { op: 'list' }], ['myco_sessions', { op: 'get', id: 's1' }],
      ['myco_skills', { op: 'list' }], ['myco_skills', { op: 'get', id: 'k1' }], ['myco_spores', { op: 'list' }], ['myco_spores', { op: 'get', id: 'sp1' }],
      ['myco_spores', { op: 'save', content: 'x', type: 'decision' }], ['myco_spores', { op: 'supersede' }], ['myco_spores', { op: 'consolidate' }], ['myco_spores', { op: 'obsolete' }],
      ['myco_plans', { op: 'delete', id: 'p1' }], ['myco_plans', { op: 'save', content: 'x' }],
      ['myco_cortex', { op: 'maintenance_summary' }], ['myco_cortex', { op: 'projects_activity' }], ['myco_cortex', { op: 'instructions' }],
      ['myco_cortex', { op: 'canopy_map' }], ['myco_cortex', { op: 'canopy_entry' }], ['myco_cortex', { op: 'notifications' }],
      ['myco_agent', { op: 'runs' }], ['myco_agent', {}], ['myco_sessions', { op: 'purge' }], ['myco_plans', { op: 5 }],
    ];
    for (const [tool, args] of table) expect({ tool, args, server: judged(tool, args) }).toEqual({ tool, args, server: isAllowedExternalCall(tool, args) });
    expect({ server: judged('myco_plans', { op: '' }), member: isAllowedExternalCall('myco_plans', { op: '' }) }).toEqual({ server: false, member: true });
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

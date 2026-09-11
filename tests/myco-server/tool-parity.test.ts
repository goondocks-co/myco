/**
 * Gate: the tools the Deployment serves are the tools the member side declares.
 *
 * The seven definitions in `packages/myco/src/tools/definitions.ts` are what
 * every skill and agent has learned; the server serves the same names, the same
 * schemas and the same descriptions, minus the retired Grove pivot and with one
 * named difference — the tenancy argument's description, which speaks of a Deployment
 * rather than a Grove. A second difference fails here by name.
 *
 * The registry is held complete against each tool's op enum: every op is served
 * or named as not served with the issue that delivers it, and no op is served
 * that the definition does not declare.
 */
import { describe, expect, it } from 'bun:test';
import { TOOL_DEFINITIONS as MEMBER_DEFINITIONS } from '@myco/tools/definitions.js';
import { GROVE_PIVOT, PROJECT_PIVOT as MEMBER_PROJECT_PIVOT } from '@myco/tools/pivot.js';
import { EXTERNAL_TOOL_ALLOWLIST as MEMBER_ALLOWLIST, isAllowedExternalCall } from '@myco/mcp/external-surface.js';
import { isRunTool, isWriteOp, PROJECT_PIVOT, RUN_TOOLS, SERVED_TOOLS, WRITE_OPS, type AnyTool, type ServedTool } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { EXTERNAL_PROJECT_DESCRIPTION, EXTERNAL_TOOL_ALLOWLIST, EXTERNAL_TOOLS, externalDefinitions, isExternalCall } from '@myco-server-worker/mcp/external.js';
import { NO_OP, TOOL_REGISTRY, opOf } from '@myco-server-worker/mcp/registry.js';
import { ALWAYS_ALLOWED, RUN_TOOL_MAP, RUN_TOOL_REGISTRY, runAllowlist, runDefinitions } from '@myco-server-worker/mcp/run-surface.js';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';

/** The one property whose description the server words for a Deployment. Both sides spell the key once, and this holds the two spellings equal. */
const EXCEPTED = PROJECT_PIVOT;
const RETIRED = GROVE_PIVOT;
/** Properties the Deployment serves beyond the member definition, by tool: each is a named difference, worded in the server definition. */
const ADDED: Record<string, readonly string[]> = {
  myco_plans: ['prompt_id'], myco_search: ['mode', 'session_id'],
  // A Deployment holds many Projects; the member's run history has one vault and takes no tenancy argument.
  myco_agent: [PROJECT_PIVOT],
  // #1149: what a grant's write cites in place of the session it has none of.
  // #1152: the agent-line projection, written at extraction; the member side's 1.4 dispatcher is not edited before the sweep.
  myco_spores: ['provenance_kind', 'provenance_ref', 'agent_line', 'prompt_id'],
};

/**
 * The (tool, op) pairs the Deployment's external surface serves and the member
 * side does not, each named with the child that added it.
 *
 * The gate stays two-directional across this: the server allowlist must equal
 * the member's plus exactly these pairs. A server entry missing from both
 * fails, and an entry named here that the server does not serve fails too, so
 * neither surface can drift in either direction unnoticed.
 *
 * #1149: an External Agent grant records what it found. The member-side
 * surface (`packages/myco/src/mcp/external-surface.ts`) narrows the 1.4
 * daemon's own listener, which is not edited before the #1170 sweep.
 */
const SERVER_ONLY_EXTERNAL_CALLS: Readonly<Record<string, readonly string[]>> = {
  myco_spores: ['save', 'supersede'],
};

const byName = <T extends { name: string }>(defs: readonly T[]): Map<string, T> => new Map(defs.map((d) => [d.name, d]));

/** A member definition as the server must serve it: the Grove pivot gone, the excepted description taken from the server. */
function expected(member: (typeof MEMBER_DEFINITIONS)[number], server: (typeof TOOL_DEFINITIONS)[number]) {
  const { [RETIRED]: _retired, ...properties } = member.inputSchema.properties as Record<string, Record<string, unknown>>;
  if (properties[EXCEPTED] !== undefined) {
    properties[EXCEPTED] = { ...properties[EXCEPTED], description: (server.inputSchema.properties[EXCEPTED] as { description: string }).description };
  }
  for (const added of ADDED[member.name] ?? []) {
    const served = (server.inputSchema.properties as Record<string, unknown>)[added];
    expect({ tool: member.name, added, declared: served !== undefined }).toEqual({ tool: member.name, added, declared: true });
    properties[added] = served as Record<string, unknown>;
  }
  return { ...member, inputSchema: { ...member.inputSchema, properties } };
}

const opsOf = (def: { inputSchema: { properties: Record<string, unknown> } }): string[] | null => {
  const op = def.inputSchema.properties.op as { enum?: readonly unknown[] } | undefined;
  return op?.enum ? op.enum.filter((v): v is string => typeof v === 'string') : null;
};

describe('tool parity', () => {

  /**
   * A retired spelling of the tenancy key must not reappear on either side.
   *
   * The Deployment refuses an argument its schema does not declare; the
   * member's 1.4 dispatcher walks the declared properties and ignores the rest.
   * A definition that declared BOTH spellings would admit the retired one on
   * both sides, so the definitions themselves are held to one spelling here,
   * and `mcp.test.ts` holds the refusal of the other.
   */
  it('declares the tenancy key under one spelling, and never the retired one', () => {
    const RETIRED_PIVOT = 'project_id';
    for (const defs of [TOOL_DEFINITIONS, MEMBER_DEFINITIONS]) {
      for (const d of defs) {
        expect({ tool: d.name, retired: RETIRED_PIVOT in d.inputSchema.properties }).toEqual({ tool: d.name, retired: false });
      }
    }
    expect(PROJECT_PIVOT).not.toBe(RETIRED_PIVOT);
  });

  /**
   * Every narrowing keeps the property set whole. `callTool` judges arguments
   * against the full definition, so a narrowing that dropped a property would
   * advertise less than the validator accepts and refuse nothing; holding the
   * key sets equal keeps the schema a caller reads the schema its call is judged by.
   */
  it('narrows ops and the tenancy description only: every served schema declares the full definition\'s property set', () => {
    const full = new Map<string, string[]>([...TOOL_DEFINITIONS, ...RUN_DEFINITIONS].map((d) => [String(d.name), Object.keys(d.inputSchema.properties).sort()]));
    const narrowed = [
      ...externalDefinitions(),
      ...Object.keys(TASK_TOOLS).flatMap((task) => runDefinitions(runAllowlist(TASK_TOOLS[task], { dryRun: false }))),
    ];
    expect(narrowed.length).toBeGreaterThan(0);
    for (const d of narrowed) {
      const declared = full.get(String(d.name));
      expect({ tool: String(d.name), declared: declared !== undefined }).toEqual({ tool: String(d.name), declared: true });
      expect({ tool: String(d.name), properties: Object.keys(d.inputSchema.properties).sort() }).toEqual({ tool: String(d.name), properties: declared! });
    }
  });

  it('spells the tenancy key once on each side, and the two agree', () => {
    expect(PROJECT_PIVOT).toBe(MEMBER_PROJECT_PIVOT);
    for (const def of TOOL_DEFINITIONS) {
      expect({ tool: def.name, retired: RETIRED in def.inputSchema.properties }).toEqual({ tool: def.name, retired: false });
    }
  });

  /**
   * The write markers are one list, and the run surface derives from it rather
   * than restating it. A second list would drift, and the surface that drifted
   * would be the one that decides whether a dry run may write.
   */
  it('marks every write op once, and every marked op is one the registry serves', () => {
    for (const [tool, ops] of Object.entries(WRITE_OPS)) {
      for (const op of ops ?? []) {
        const entry = isRunTool(tool) ? RUN_TOOL_REGISTRY[tool].ops[op] : TOOL_REGISTRY[tool as ServedTool].ops[op];
        expect({ tool, op, served: entry !== undefined && 'handler' in entry }).toEqual({ tool, op, served: true });
      }
    }
    for (const def of [...TOOL_DEFINITIONS, ...RUN_DEFINITIONS]) {
      const ops = opsOf(def) ?? [NO_OP];
      const writes = ops.some((op) => isWriteOp(def.name as AnyTool, op));
      expect({ tool: def.name, writes, readOnlyHint: def.annotations?.readOnlyHint }).toEqual({ tool: def.name, writes, readOnlyHint: !writes });
    }
  });

  it('serves exactly the catalogued tools, and the member side declares every one of them', () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([...SERVED_TOOLS].sort());
    const member = byName(MEMBER_DEFINITIONS);
    expect(TOOL_DEFINITIONS.filter((d) => !member.has(d.name)).map((d) => d.name)).toEqual([]);
  });

  it('serves each definition as the member side declares it, minus the Grove pivot, with the tenancy description as the only worded difference', () => {
    const member = byName(MEMBER_DEFINITIONS);
    for (const server of TOOL_DEFINITIONS) {
      expect({ tool: String(server.name), definition: server as object }).toEqual({ tool: String(server.name), definition: expected(member.get(server.name)!, server) as object });
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
    const withServerOnly = Object.fromEntries(Object.entries(MEMBER_ALLOWLIST).map(
      ([tool, ops]) => [tool, new Set([...ops, ...(SERVER_ONLY_EXTERNAL_CALLS[tool] ?? [])])],
    ));
    expect(entries(EXTERNAL_TOOL_ALLOWLIST)).toEqual(entries(withServerOnly));
    for (const [tool, ops] of Object.entries(SERVER_ONLY_EXTERNAL_CALLS)) {
      for (const op of ops) {
        expect({ tool, op, server: EXTERNAL_TOOL_ALLOWLIST[tool]?.has(op) ?? false, member: MEMBER_ALLOWLIST[tool]?.has(op) ?? false })
          .toEqual({ tool, op, server: true, member: false });
      }
    }
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
      // Read through the shared key: spelling it here would pass vacuously the
      // moment the key moved, which is the direction this narrowing fails in.
      const pivot = d.inputSchema.properties[EXCEPTED] as { description?: string } | undefined;
      expect({ tool: d.name, declared: pivot !== undefined, pivot: pivot?.description ?? null })
        .toEqual({ tool: d.name, declared: true, pivot: EXTERNAL_PROJECT_DESCRIPTION });
      // Every definition, served or member-side, carries the schema this reads.
      const rest = (def: { inputSchema: { properties: Record<string, unknown> } }): object => {
        const { op: _op, [EXCEPTED]: _pivot, ...properties } = def.inputSchema.properties;
        return { ...def, inputSchema: { ...def.inputSchema, properties } };
      };
      expect({ tool: String(d.name), rest: rest(d) }).toEqual({ tool: String(d.name), rest: rest(served.get(d.name)!) });
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
      ['myco_cortex', { op: 'canopy_entry' }], ['myco_cortex', { op: 'notifications' }],
      ['myco_agent', { op: 'runs' }], ['myco_agent', {}], ['myco_sessions', { op: 'purge' }], ['myco_plans', { op: 5 }],
    ];
    const serverOnly = (tool: ServedTool, args: Record<string, unknown>) => (SERVER_ONLY_EXTERNAL_CALLS[tool] ?? []).includes(opOf(tool, args));
    for (const [tool, args] of table) {
      expect({ tool, args, server: judged(tool, args) })
        .toEqual({ tool, args, server: serverOnly(tool, args) ? true : isAllowedExternalCall(tool, args) });
    }
    expect({ server: judged('myco_plans', { op: '' }), member: isAllowedExternalCall('myco_plans', { op: '' }) }).toEqual({ server: false, member: true });
  });

  it('maps every run tool onto a registry entry that some task declares, keeps the two surfaces disjoint, and lists a run its allowlisted names with the op enum narrowed', () => {
    // The one assertion that makes "the Myco agent does not share a tool
    // surface with Symbionts" mechanical rather than a convention.
    expect(RUN_TOOLS.filter((t) => (SERVED_TOOLS as readonly string[]).includes(t))).toEqual([]);
    expect(RUN_DEFINITIONS.map((d) => d.name).sort()).toEqual([...RUN_TOOLS].sort());
    expect(Object.keys(RUN_TOOL_REGISTRY).sort()).toEqual([...RUN_TOOLS].sort());
    // No run-only name reaches the member side, which is what keeps the parity
    // gate above judging the seven and only the seven.
    expect(MEMBER_DEFINITIONS.filter((d) => (RUN_TOOLS as readonly string[]).includes(d.name))).toEqual([]);

    const declared = new Set(Object.values(TASK_TOOLS).flat());
    for (const [source, targets] of Object.entries(RUN_TOOL_MAP)) {
      expect({ source, declared: declared.has(source) }).toEqual({ source, declared: true });
      expect({ source, targets: targets.length > 0 }).toEqual({ source, targets: true });
      for (const { tool, op } of targets) {
        const keyed = isRunTool(tool)
          ? op in RUN_TOOL_REGISTRY[tool].ops && 'handler' in RUN_TOOL_REGISTRY[tool].ops[op]
          : op === NO_OP
            ? TOOL_REGISTRY[tool].defaultOp === null && NO_OP in TOOL_REGISTRY[tool].ops
            : op in TOOL_REGISTRY[tool].ops && 'handler' in TOOL_REGISTRY[tool].ops[op];
        expect({ source, tool, op, keyed }).toEqual({ source, tool, op, keyed: true });
      }
    }
    // Every declared op of a run-only tool is one the map or the always-allowed
    // pair can reach: a definition offering an op no task unlocks is dead.
    const reachable = new Set(Object.values(RUN_TOOL_MAP).flat().map((t) => `${t.tool}.${t.op}`));
    for (const def of RUN_DEFINITIONS) {
      for (const op of opsOf(def) ?? []) {
        expect({ tool: def.name, op, reachable: reachable.has(`${def.name}.${op}`) }).toEqual({ tool: def.name, op, reachable: true });
      }
    }

    const extraction = runAllowlist(TASK_TOOLS['extract-curate'], { dryRun: false });
    expect([...extraction.entries()].map(([tool, ops]) => [tool, [...ops].sort()]).sort())
      .toEqual([
        ['myco_run', ['report', 'state_get', 'state_set']], ['myco_run_prompts', ['mark_processed', 'unprocessed']],
        ['myco_run_sessions', ['list']], ['myco_run_spores', ['get', 'list']],
        ['myco_search', [NO_OP]], ['myco_spores', ['consolidate', 'obsolete', 'save', 'supersede']],
      ]);
    // A dry run keeps every read and loses every write, and keeps `report`,
    // which the close gate reads whether or not the run wrote anything.
    const dry = runAllowlist(TASK_TOOLS['extract-curate'], { dryRun: true });
    expect([...dry.get('myco_spores') ?? []]).toEqual([]);
    expect([...dry.get('myco_run_prompts')!]).toEqual(['unprocessed']);
    expect([...dry.get('myco_run')!].sort()).toEqual([ALWAYS_ALLOWED.op, 'state_get']);
    // A task declaring no tools of its own still closes.
    const bare = runAllowlist(TASK_TOOLS['container-smoke'], { dryRun: false });
    expect([...bare.entries()].map(([tool, ops]) => [tool, [...ops]])).toEqual([['myco_run', ['report']]]);
    expect(runDefinitions(bare).map((d) => [d.name, (d.inputSchema.properties.op as { enum: string[] }).enum])).toEqual([['myco_run', ['report']]]);
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

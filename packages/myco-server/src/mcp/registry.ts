/**
 * Every (tool, op) the Deployment answers, and every one it names as not yet
 * served. Keyed by `SERVED_TOOLS`, and held complete against each tool's op
 * enum by `tests/myco-server/tool-parity.test.ts`: an op can be served or
 * named, never absent.
 *
 * A `notServed` entry names the issue that delivers the op, or `never` for an
 * op a Deployment does not offer. The tool answers it as a `not_served` error,
 * so a caller sees what is missing rather than an empty result.
 */
import { SERVED_TOOLS, type ServedTool } from '../core/tool-catalogue.js';
import type { ToolContext } from './context.js';
import { handleAgent } from './tools/agent.js';
import { handleCortexDigest, handleCortexInstructions, handleCortexProjectsActivity } from './tools/cortex.js';
import { handlePlans } from './tools/plans.js';
import { handleSessions } from './tools/sessions.js';
import { handleSkills } from './tools/skills.js';
import { handleSpores } from './tools/spores.js';
import type { ToolInput } from './validate.js';

export type ToolHandler = (input: ToolInput, ctx: ToolContext) => Promise<unknown>;
export type RegistryEntry = { handler: ToolHandler } | { notServed: string };

export interface ToolEntry {
  /** The op a call without one runs; null for a tool with no op concept. */
  defaultOp: string | null;
  ops: Record<string, RegistryEntry>;
}

/** The op key of a tool without an op concept. */
export const NO_OP = '*';

const served = (handler: ToolHandler): RegistryEntry => ({ handler });
const notServed = (by: string): RegistryEntry => ({ notServed: by });

export const TOOL_REGISTRY: Record<ServedTool, ToolEntry> = {
  myco_search: { defaultOp: null, ops: { [NO_OP]: notServed('#1027') } },
  myco_cortex: {
    defaultOp: 'digest',
    ops: {
      digest: served(handleCortexDigest),
      instructions: served(handleCortexInstructions),
      canopy_map: notServed('#920'),
      canopy_entry: notServed('#920'),
      notifications: notServed('#922'),
      maintenance_summary: notServed('#923'),
      projects_activity: served(handleCortexProjectsActivity),
    },
  },
  myco_plans: {
    defaultOp: 'list',
    ops: { list: served(handlePlans), get: served(handlePlans), save: served(handlePlans), delete: notServed('never') },
  },
  myco_sessions: { defaultOp: 'list', ops: { list: served(handleSessions), get: served(handleSessions) } },
  myco_skills: { defaultOp: 'list', ops: { list: served(handleSkills), get: served(handleSkills) } },
  myco_spores: {
    defaultOp: 'list',
    ops: {
      list: served(handleSpores), get: served(handleSpores), save: served(handleSpores),
      supersede: served(handleSpores), consolidate: served(handleSpores), obsolete: served(handleSpores),
    },
  },
  myco_agent: { defaultOp: 'runs', ops: { runs: served(handleAgent), run: served(handleAgent) } },
};

/** The op a call resolves to: the argument when given, else the tool's default; `NO_OP` for a tool without one. */
export function opOf(tool: ServedTool, input: ToolInput): string {
  const entry = TOOL_REGISTRY[tool];
  if (entry.defaultOp === null) return NO_OP;
  return typeof input.op === 'string' ? input.op : entry.defaultOp;
}

/** The registry entry for a call, or undefined when the tool declares no such op. */
export function entryFor(tool: ServedTool, op: string): RegistryEntry | undefined {
  return TOOL_REGISTRY[tool].ops[op];
}

/** Every tool the registry keys, in catalogue order. */
export const REGISTERED_TOOLS: readonly ServedTool[] = SERVED_TOOLS.filter((t) => t in TOOL_REGISTRY);

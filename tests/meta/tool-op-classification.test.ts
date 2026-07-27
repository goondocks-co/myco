/**
 * Meta gate: every (tool, op) pair is classified read-or-write for project
 * write admission.
 *
 * `tools/lease-admission.ts` decides whether a `myco tool call` mutates
 * project state, and therefore whether it must be refused while the
 * project's write lease is held. That decision is a hand-maintained table.
 * A table nobody checks drifts: someone adds an op to a tool's schema, the
 * table doesn't grow, and the classifier silently answers for a call it has
 * never seen.
 *
 * `isMutatingToolCall` fails CLOSED, so an unclassified op is treated as a
 * write and refused mid-transition rather than admitted through one — the
 * safe direction, but a *silent* one: a new READ op would start refusing
 * during transitions with nothing to explain why. This gate turns that
 * silence into a build failure.
 *
 * Static scan of the schema enums; no daemon, no DB.
 */

import { describe, expect, it } from 'bun:test';
import { TOOL_DEFINITIONS } from '@myco/tools/definitions.js';
import { TOOL_OP_CLASSIFICATION, isMutatingToolCall } from '@myco/tools/lease-admission.js';
import { effectiveOp } from '@myco/tools/op-resolution.js';

/** The `op` enum a tool's schema declares, or null when it has no op. */
function declaredOps(toolName: string): string[] | null {
  const definition = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!definition) return null;
  const op = definition.inputSchema.properties.op as { enum?: readonly unknown[] } | undefined;
  if (!op?.enum) return null;
  return op.enum.filter((v): v is string => typeof v === 'string');
}

describe('tool op classification meta gate', () => {
  it('scans a non-trivial surface (the scan is wired, not vacuously empty)', () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(5);
    expect(Object.keys(TOOL_OP_CLASSIFICATION).length).toBe(TOOL_DEFINITIONS.length);
  });

  it('classifies every tool that exists', () => {
    const unclassified = TOOL_DEFINITIONS
      .map((t) => t.name)
      .filter((name) => !(name in TOOL_OP_CLASSIFICATION));
    expect(unclassified, `tool(s) with no write-admission classification:\n  ${unclassified.join('\n  ')}\n\n`
      + 'Add each to TOOL_OP_CLASSIFICATION in tools/lease-admission.ts, splitting its ops '
      + 'into read (admitted while a project write lease is held) and write (refused). '
      + 'A tool with no `op` concept is classified `null`.').toEqual([]);
  });

  it('classifies every op each tool declares, and invents none', () => {
    for (const [toolName, entry] of Object.entries(TOOL_OP_CLASSIFICATION)) {
      const ops = declaredOps(toolName);
      if (entry === null) {
        expect(ops, `${toolName} is classified \`null\` (no op concept) but its schema declares an op enum. `
          + 'Split those ops into read/write.').toBeNull();
        continue;
      }
      expect(ops, `${toolName} is classified with read/write op lists but its schema declares no op enum. `
        + 'Classify it `null` instead.').not.toBeNull();

      const classified = [...entry.read, ...entry.write].sort();
      const declared = [...(ops ?? [])].sort();

      const missing = declared.filter((op) => !classified.includes(op));
      expect(missing, `${toolName} declares op(s) the write-admission table does not classify:\n`
        + `  ${missing.join(', ')}\n\nAdd each to the read or write list in tools/lease-admission.ts. `
        + 'Unclassified ops fail closed (refused during a transition), so leaving this is not a '
        + 'safety hole — but a new READ op would start refusing with nothing to explain why.').toEqual([]);

      const phantom = classified.filter((op) => !declared.includes(op));
      expect(phantom, `${toolName} classifies op(s) its schema does not declare:\n`
        + `  ${phantom.join(', ')}\n\nRemove them — a stale entry means the table is describing a `
        + 'surface that no longer exists.').toEqual([]);

      const overlap = entry.read.filter((op) => entry.write.includes(op));
      expect(overlap, `${toolName} classifies op(s) as BOTH read and write: ${overlap.join(', ')}`).toEqual([]);
    }
  });

  it('resolves an omitted op to the same default the tool schema documents', () => {
    // The classifier judges the op a call would ACTUALLY run under. If this
    // drifted from the real default, an omitted `op` would be judged as a
    // different op than the handler executes — e.g. myco_spores with no op
    // resolving to a write and refusing a plain list.
    for (const definition of TOOL_DEFINITIONS) {
      const ops = declaredOps(definition.name);
      if (!ops) continue;
      const op = definition.inputSchema.properties.op as { description?: string } | undefined;
      const documented = op?.description?.match(/default:\s*"([a-z_]+)"/)?.[1];
      if (!documented) continue;
      expect(effectiveOp(definition.name, {}),
        `${definition.name}: op-resolution default disagrees with the schema's documented default `
        + `("${documented}"). tools/op-resolution.ts must mirror tools/definitions.ts.`).toBe(documented);
    }
  });

  it('treats an unknown tool and an unknown op as writes (fails closed)', () => {
    expect(isMutatingToolCall('myco_not_a_tool', {})).toBe(true);
    expect(isMutatingToolCall('myco_plans', { op: 'op_added_later' })).toBe(true);
  });

  it('admits the reads and refuses the writes it is meant to', () => {
    // Guards against a table that is complete but inverted.
    expect(isMutatingToolCall('myco_search', { query: 'x' })).toBe(false);
    expect(isMutatingToolCall('myco_plans', { op: 'get' })).toBe(false);
    expect(isMutatingToolCall('myco_plans', {})).toBe(false); // defaults to list
    expect(isMutatingToolCall('myco_plans', { op: 'save' })).toBe(true);
    expect(isMutatingToolCall('myco_plans', { op: 'delete' })).toBe(true);
    expect(isMutatingToolCall('myco_spores', { op: 'list' })).toBe(false);
    expect(isMutatingToolCall('myco_spores', { op: 'save' })).toBe(true);
    expect(isMutatingToolCall('myco_spores', { op: 'supersede' })).toBe(true);
    expect(isMutatingToolCall('myco_spores', { op: 'consolidate' })).toBe(true);
    expect(isMutatingToolCall('myco_spores', { op: 'obsolete' })).toBe(true);
    expect(isMutatingToolCall('myco_cortex', {})).toBe(false); // defaults to digest
    expect(isMutatingToolCall('myco_agent', {})).toBe(false); // defaults to runs
  });
});

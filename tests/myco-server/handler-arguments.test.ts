/**
 * Gate: a handler reads only the arguments its tool's schema declares.
 *
 * `validateInput` refuses any key a definition does not name, so an argument a
 * handler reads without declaring is one no caller can ever pass: the handler's
 * branch is dead and the feature it implements is unreachable. This holds the
 * two halves together by reading the source of every handler the registry
 * serves and asserting every key it reads off `input` is a declared property of
 * its tool.
 *
 * Reads are found by the spellings the handlers use — `input.<key>`,
 * `input['<key>']`, `input[<CONSTANT>]`, and `input[<loopVar>]` over an
 * adjacent `[...] as const` list — and through every `context.ts` helper the
 * handler calls, transitively. A spelling this scan cannot resolve fails the
 * gate rather than passing it, so a read never slips through unread.
 *
 * `input` must be a whole identifier. A hyphen before it means a module path
 * such as `cortex-input.js`, whose extension would read as a key.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_PIVOT } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import { RUN_TOOL_REGISTRY } from '@myco-server-worker/mcp/run-surface.js';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco-server', 'src', 'mcp');
const read = (rel: string): string => fs.readFileSync(path.join(MCP_DIR, rel), 'utf8');

/** Named constants a handler may index `input` with, resolved to the key they spell. */
const CONSTANTS: Readonly<Record<string, string>> = { PROJECT_PIVOT };

/** The keys `source` reads off an `input` object; an index this scan cannot resolve is a failure, never a pass. */
function inputReads(source: string, where: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/(?<![\w-])input\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  for (const m of source.matchAll(/(?<![\w-])input\['([^']+)'\]/g)) keys.add(m[1]);
  const loops = new Map<string, string[]>();
  for (const m of source.matchAll(/for \(const (\w+) of \[([^\]]*)\] as const\)/g)) {
    loops.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((k) => k[1]));
  }
  for (const m of source.matchAll(/(?<![\w-])input\[([A-Za-z_]\w*)\]/g)) {
    const spelled = CONSTANTS[m[1]];
    const looped = loops.get(m[1]);
    if (spelled !== undefined) keys.add(spelled);
    else if (looped !== undefined) for (const key of looped) keys.add(key);
    else throw new Error(`${where}: input[${m[1]}] is indexed by a name this gate does not resolve; add it to CONSTANTS or read it through an adjacent [...] as const loop`);
  }
  return [...keys].sort();
}

/** Every exported function of `context.ts` with its body, each slice checked to close exactly the brace it opened. */
function contextHelpers(contextSource: string): Map<string, string> {
  const helpers = new Map<string, string>();
  for (const m of contextSource.matchAll(/^export (?:async )?function ([A-Za-z]+)\(/gm)) {
    const start = m.index!;
    const end = contextSource.indexOf('\n}', start);
    const body = contextSource.slice(start, end + 2);
    const opened = (body.match(/\{/g) ?? []).length;
    const closed = (body.match(/\}/g) ?? []).length;
    if (opened !== closed) throw new Error(`context.ts ${m[1]}: the body slice opens ${opened} braces and closes ${closed}; the gate cannot read it`);
    helpers.set(m[1], body);
  }
  return helpers;
}

/** The keys a handler reads through the `context.ts` helpers it calls, following helpers that call helpers until no new one appears. */
function helperReads(source: string, helpers: Map<string, string>): string[] {
  const called = new Set<string>();
  let frontier = [source];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const text of frontier) {
      for (const name of helpers.keys()) {
        if (!called.has(name) && new RegExp(`\\b${name}\\(`).test(text)) { called.add(name); next.push(helpers.get(name)!); }
      }
    }
    frontier = next;
  }
  return [...called].flatMap((name) => inputReads(helpers.get(name)!, `context.ts ${name}`));
}

/** Handler function name → the module under `mcp/tools/` the registry's own source imports it from. */
function handlerModules(registrySource: string): Map<string, string> {
  const modules = new Map<string, string>();
  for (const m of read(registrySource).matchAll(/import \{([^}]+)\} from '\.\/tools\/([a-z-]+)\.js'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) modules.set(name, `tools/${m[2]}.ts`);
  }
  return modules;
}

/** Both surfaces, each with the registry that dispatches it and the source that imports its handlers. */
const SURFACES = [
  { what: 'served', registry: TOOL_REGISTRY as Record<string, { ops: Record<string, unknown> }>, definitions: TOOL_DEFINITIONS, source: 'registry.ts' },
  { what: 'run-only', registry: RUN_TOOL_REGISTRY as Record<string, { ops: Record<string, unknown> }>, definitions: RUN_DEFINITIONS, source: 'run-surface.ts' },
];

describe('handler arguments', () => {
  it('serves a handler for every defined tool, and no tool the definitions do not carry', () => {
    for (const { what, registry, definitions } of SURFACES) {
      expect({ what, tools: new Set(Object.keys(registry)) }).toEqual({ what, tools: new Set(definitions.map((d) => d.name)) });
    }
  });

  it('reads only keys the tool\'s schema declares, so every branch a handler carries is one a caller can reach', () => {
    const helpers = contextHelpers(read('context.ts'));
    expect(helpers.size).toBeGreaterThan(0);

    for (const { what, registry, definitions, source } of SURFACES) {
      const modules = handlerModules(source);
      const declared = new Map(definitions.map((d) => [d.name, new Set(Object.keys(d.inputSchema.properties))]));

      for (const [tool, entry] of Object.entries(registry)) {
        const handlers = new Set(Object.values(entry.ops).flatMap((op) => ('handler' in (op as object) ? [(op as { handler: { name: string } }).handler.name] : [])));
        expect({ what, tool, handlers: handlers.size > 0 }).toEqual({ what, tool, handlers: true });
        for (const handler of handlers) {
          const module = modules.get(handler);
          expect({ what, tool, handler, imported: module !== undefined }).toEqual({ what, tool, handler, imported: true });
          const src = read(module!);
          const reads = new Set([...inputReads(src, module!), ...helperReads(src, helpers)]);
          const undeclared = [...reads].filter((key) => !declared.get(tool)!.has(key)).sort();
          expect({ what, tool, handler, undeclared }).toEqual({ what, tool, handler, undeclared: [] });
        }
      }
    }
  });

});

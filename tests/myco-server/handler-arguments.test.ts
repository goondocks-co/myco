/**
 * Gate: a handler reads only the arguments its tool's schema declares.
 *
 * `validateInput` refuses any key a definition does not name, so an argument a
 * handler reads without declaring is one no caller can ever pass: the handler's
 * branch is dead and the feature it implements is unreachable. This holds the
 * two halves together by reading the source of every handler the registry
 * serves — `input.<key>`, `input['<key>']` and `input[<CONSTANT>]` — plus the
 * reads inside each `context.ts` helper the handler calls, and asserts every
 * key is a declared property of that tool.
 *
 * Static source scan, so a key read through a computed loop (`for (const key of
 * [...])`) is out of its reach; those keys reach the validator at runtime, where
 * an undeclared one is refused, and `mcp.test.ts` holds that refusal.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_PIVOT } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco-server', 'src', 'mcp');
const read = (rel: string): string => fs.readFileSync(path.join(MCP_DIR, rel), 'utf8');

/** Named constants a handler may index `input` with, resolved to the key they spell. */
const CONSTANTS: Readonly<Record<string, string>> = { PROJECT_PIVOT };

/** Every key `source` reads off an `input` object, by the three spellings the handlers use. */
function inputReads(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\binput\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  for (const m of source.matchAll(/\binput\['([^']+)'\]/g)) keys.add(m[1]);
  for (const m of source.matchAll(/\binput\[([A-Z_][A-Z0-9_]*)\]/g)) {
    const spelled = CONSTANTS[m[1]];
    if (spelled === undefined) throw new Error(`input[${m[1]}] indexes with a constant this gate does not resolve; add it to CONSTANTS`);
    keys.add(spelled);
  }
  return [...keys].sort();
}

/** The body of one top-level function in `context.ts`, from its declaration to the next unindented brace. */
function helperBody(contextSource: string, name: string): string {
  const start = contextSource.search(new RegExp(`^export (?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`context.ts declares no exported function ${name}`);
  const end = contextSource.indexOf('\n}', start);
  return contextSource.slice(start, end);
}

/** Handler function name → the module under `mcp/tools/` that `registry.ts` imports it from. */
function handlerModules(): Map<string, string> {
  const modules = new Map<string, string>();
  for (const m of read('registry.ts').matchAll(/import \{([^}]+)\} from '\.\/tools\/([a-z-]+)\.js'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) modules.set(name, `tools/${m[2]}.ts`);
  }
  return modules;
}

describe('handler arguments', () => {
  it('reads only keys the tool\'s schema declares, so every branch a handler carries is one a caller can reach', () => {
    const modules = handlerModules();
    expect(modules.size).toBeGreaterThan(0);
    const contextSource = read('context.ts');
    const helpers = [...contextSource.matchAll(/^export (?:async )?function ([A-Za-z]+)\(/gm)].map((m) => m[1]);
    const declared = new Map(TOOL_DEFINITIONS.map((d) => [d.name, new Set(Object.keys(d.inputSchema.properties))]));

    const checked: string[] = [];
    for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
      const handlers = new Set(Object.values(entry.ops).flatMap((op) => ('handler' in op ? [op.handler.name] : [])));
      for (const handler of handlers) {
        const module = modules.get(handler);
        expect({ tool, handler, imported: module !== undefined }).toEqual({ tool, handler, imported: true });
        const source = read(module!);
        const reads = new Set(inputReads(source));
        for (const helper of helpers) {
          if (new RegExp(`\\b${helper}\\(`).test(source)) for (const key of inputReads(helperBody(contextSource, helper))) reads.add(key);
        }
        const undeclared = [...reads].filter((key) => !declared.get(tool)!.has(key)).sort();
        expect({ tool, handler, undeclared }).toEqual({ tool, handler, undeclared: [] });
        checked.push(`${tool}:${handler}`);
      }
    }
    expect(checked.length).toBe(new Set(checked).size);
    expect(checked.length).toBeGreaterThanOrEqual(TOOL_DEFINITIONS.length);
  });
});

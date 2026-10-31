/**
 * Meta gate: no clock and no claim reads a session document.
 *
 * Document content is read by request handlers, admitted run material endpoints and the publisher. The worker claim
 * (`api/worker.ts` short of the run tool surface it also serves, and `core/harness.ts`), every pulled stage's due, head, build and claim statements (the registry
 * `core/pulled-stages.ts` and each module whose source declares a `PulledStage`), card and learning state
 * (`core/turn-cards.ts`, `core/learning-sessions.ts`) and titling's eligibility and dispatch (`core/titling.ts`) must
 * reach neither `content/` nor the publisher. The wake tick may reach `content/` only through `ingest/publish.ts`, which
 * only the job table imports. Edges come from the runtime's own import scanner. A dynamic `import()` or `require()` in a
 * walked module must take one plain string literal; any other argument, an interpolated template included, names no
 * module the gate can follow and fails it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco-server', 'src');
const PUBLISHER = 'ingest/publish.ts';
const PUBLISHER_IMPORTERS = ['core/jobs-run.ts'];
/** The admitted run's tool surface, which `api/worker.ts` serves beside the claim: run material endpoints may read pages. */
const RUN_SURFACE = 'mcp/run-surface.ts';
const CATALOG_ONLY = ['api/worker.ts', 'core/harness.ts', 'core/pulled-stages.ts', 'core/turn-cards.ts', 'core/learning-sessions.ts', 'core/titling.ts'];
const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false });
const UNKNOWN_DYNAMIC = /(?<![\w$.])(?:import|require)\s*\(\s*(?!(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`\\$]*`)\s*[,)])/;

/** Whether a module's code holds a dynamic import whose specifier is not one plain string literal. */
const unknownDynamicImport = (source: string): boolean => UNKNOWN_DYNAMIC.test(transpiler.transformSync(source));

const relative = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');
const isContent = (file: string): boolean => file.startsWith('content/');

/** The source modules `entry` reaches, each with the module that first imported it, never walking past `stop`. */
function closure(entry: string, stop: readonly string[] = []): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const queue: [string, string | null][] = [[entry, null]];
  while (queue.length > 0) {
    const [file, from] = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, from);
    if (stop.includes(file)) continue;
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    if (unknownDynamicImport(source)) throw new Error(`unknown dynamic import in ${file}`);
    for (const { path: specifier } of transpiler.scanImports(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(path.resolve(SRC, path.dirname(file), specifier.replace(/\.js$/, '.ts')));
      if (fs.existsSync(path.join(SRC, target))) queue.push([target, file]);
    }
  }
  return seen;
}

/** The import chain from the entry to `file`. */
function chain(seen: Map<string, string | null>, file: string): string {
  const links = [file];
  for (let from = seen.get(file); from != null; from = seen.get(from)) links.unshift(from);
  return links.join(' > ');
}

/** Every source module, relative to the server's source root. */
const sources = (): string[] => fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts')).map((file) => file.split(path.sep).join('/'));

const offending = (seen: Map<string, string | null>, bad: (file: string) => boolean): string[] =>
  [...seen.keys()].filter(bad).map((file) => chain(seen, file));

describe('session documents are read by no clock and no claim', () => {
  it('the worker claim, every pulled stage, card and learning state and titling reach no document reader and not the publisher', () => {
    const stages = sources().filter((file) => /\bPulledStage\b/.test(fs.readFileSync(path.join(SRC, file), 'utf8')));
    expect(stages).toContain('core/learning-stages.ts');
    for (const entry of [...CATALOG_ONLY, ...stages])
      expect(offending(closure(entry, entry === 'api/worker.ts' ? [RUN_SURFACE] : []), (file) => isContent(file) || file === PUBLISHER)).toEqual([]);
  });

  it('the tick reaches document code only through the publisher', () => {
    expect(offending(closure('core/tick.ts', [PUBLISHER]), isContent)).toEqual([]);
    expect(closure('core/tick.ts').has(PUBLISHER)).toBe(true);
  });

  it('a dynamic import the gate cannot resolve fails it', () => {
    const load = (argument: string) => `export async function load(name: string) { return import(${argument}); }`;
    expect(['`../content/${name}.js`', "'../content/' + name", 'name'].filter((argument) => !unknownDynamicImport(load(argument)))).toEqual([]);
    expect(unknownDynamicImport(load("'../content/document-reader.js'")) || unknownDynamicImport(load('`../content/document-reader.js`'))).toBe(false);
  });

  it('only the job table imports the publisher', () => {
    const importers = sources()
      .filter((file) => !isContent(file) && file !== PUBLISHER)
      .filter((file) => transpiler.scanImports(fs.readFileSync(path.join(SRC, file), 'utf8'))
        .some(({ path: specifier }) => specifier.startsWith('.')
          && relative(path.resolve(SRC, path.dirname(file), specifier.replace(/\.js$/, '.ts'))) === PUBLISHER));
    expect(importers).toEqual(PUBLISHER_IMPORTERS);
  });
});

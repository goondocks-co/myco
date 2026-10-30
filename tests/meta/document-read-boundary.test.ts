/**
 * Meta gate: no clock and no claim reads a session document.
 *
 * Document content is read by request handlers, admitted run material endpoints and the publisher. The worker claim
 * (`api/worker.ts`, `core/harness.ts`) must reach neither `content/` nor the publisher, and the wake tick may reach
 * `content/` only through `ingest/publish.ts`, which only the transcript-parse job's module imports. Edges come from
 * the runtime's own import scanner; a non-literal dynamic import in a walked module names no module the gate can
 * follow and fails it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco-server', 'src');
const PUBLISHER = 'ingest/publish.ts';
const PUBLISHER_IMPORTERS = ['ingest/view-cutover.ts'];
const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false });
const UNKNOWN_DYNAMIC = /\b(?:import|require)\s*\(\s*(?!['"`])/;

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
    if (UNKNOWN_DYNAMIC.test(transpiler.transformSync(source))) throw new Error(`unknown dynamic import in ${file}`);
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

const offending = (seen: Map<string, string | null>, bad: (file: string) => boolean): string[] =>
  [...seen.keys()].filter(bad).map((file) => chain(seen, file));

describe('session documents are read by no clock and no claim', () => {
  it('the worker claim reaches no document reader and not the publisher', () => {
    for (const entry of ['api/worker.ts', 'core/harness.ts'])
      expect(offending(closure(entry), (file) => isContent(file) || file === PUBLISHER)).toEqual([]);
  });

  it('the tick reaches document code only through the publisher', () => {
    expect(offending(closure('core/tick.ts', [PUBLISHER]), isContent)).toEqual([]);
    expect(closure('core/tick.ts').has(PUBLISHER)).toBe(true);
  });

  it('only the transcript-parse job imports the publisher', () => {
    const importers = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts')).map((file) => file.split(path.sep).join('/'))
      .filter((file) => !isContent(file) && file !== PUBLISHER)
      .filter((file) => transpiler.scanImports(fs.readFileSync(path.join(SRC, file), 'utf8'))
        .some(({ path: specifier }) => specifier.startsWith('.')
          && relative(path.resolve(SRC, path.dirname(file), specifier.replace(/\.js$/, '.ts'))) === PUBLISHER));
    expect(importers).toEqual(PUBLISHER_IMPORTERS);
  });
});

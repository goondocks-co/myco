import { write } from '@myco-server-worker/db/index.js';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { boundaryInventory, boundarySites, boundaryViolations, changeCountInventory, changeCountSites, changeCountViolations, gatedSites, staleStoreAllowances } from './helpers/db-boundary.js';

const source = (text: string) => ts.createSourceFile('core/example.ts', text, ts.ScriptTarget.Latest, true);
const inventory = (text: string) => new Map([['core/example.ts', boundarySites(source(text))]]);

it('keeps SQL producers and store execution inside db, naming every site outside it', () => {
  const root = fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url));
  expect(boundaryViolations(boundaryInventory(root))).toEqual([]);
});

it('names only allowances that still reach the store', () => {
  expect(staleStoreAllowances(fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url)))).toEqual([]);
});

it('counts direct store calls inside db but not SQL text, and leaves allowed and frozen files alone', () => {
  const sites = boundarySites(source('db.prepare(sql); db.batch([]); const text = `SELECT id FROM runs WHERE id = ?`; prepareBound(db, bound);'));
  expect(gatedSites('db/runs/example.ts', sites).map(site => site.kind)).toEqual(['prepare', 'batch']);
  expect(gatedSites('db/kernel/commit.ts', sites)).toEqual([]);
  expect(gatedSites('db/schema-v117.ts', sites)).toEqual([]);
  expect(boundaryViolations(new Map([['db/runs/example.ts', gatedSites('db/runs/example.ts', sites)]]))).toEqual([
    'db/runs/example.ts: direct store calls at line 1 (prepare), line 1 (batch); use a kernel definition and commit',
  ]);
});

it('counts a call compiling a Bound outside db under a known name or by its signature', () => {
  expect(boundarySites(source('prepareClaimCompanion(db, bound);')).map(site => site.kind)).toEqual(['compile']);
  const text = `
    interface Bound { name: string }
    interface PreparedStatement { run(): void }
    declare function renamed(db: unknown, bound: Bound): PreparedStatement;
    declare function unrelated(db: unknown, name: string): PreparedStatement;
    declare function nullable(db: unknown, bound: Bound | string): PreparedStatement | string;
    declare function spread(...args: [unknown, Bound]): PreparedStatement;
    declare const kernel: { renamed(db: unknown, bound: Bound): PreparedStatement };
    declare const held: Bound;
    renamed(null, held);
    unrelated(null, 'x');
    nullable(null, held);
    spread(null, held);
    kernel.renamed(null, held);
  `;
  const file = source(text);
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === file.fileName ? file : undefined;
  const program = ts.createProgram([file.fileName], { noLib: true }, host);
  expect(boundarySites(file, program.getTypeChecker()).map(site => site.line)).toEqual([10, 12, 13, 14]);
});

it('keeps change-count reads to the store adapters', () => {
  const root = fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url));
  expect(changeCountViolations(changeCountInventory(root))).toEqual([]);
});

it('catches the ordinary spellings of a change-count read, and leaves unrelated changes and written results alone', () => {
  const sites = changeCountSites(source(`
    // result.meta.changes
    if (result.meta.changes === 1) done();
    const n = other?.meta?.changes;
    const m = result.meta['changes'];
    const { changes } = result.meta;
    const { meta: { changes: renamed } } = result;
    const { changes: elsewhere } = diff;
    git.changes.push(pending);
    return { results: [], meta: { changes: 0 } };
  `));
  expect(sites.map(site => site.line)).toEqual([3, 4, 5, 6, 7]);
  const reads = new Map([['core/example.ts', sites]]);
  expect(changeCountViolations(reads)).toEqual([
    'core/example.ts: .meta.changes reads at line 3 (changes), line 4 (changes), line 5 (changes), line 6 (changes), line 7 (changes); decide the outcome from a RETURNING row or an in-batch assertion',
  ]);
  expect(changeCountViolations(new Map([['core/example.ts', []]]))).toEqual([]);
});

it('catches a change-count read through an alias of the metadata by its type', () => {
  const text = `
    interface Run { results: unknown[]; meta: { changes: number } }
    declare const run: Run;
    const stats = run.meta;
    stats.changes;
    declare const diff: { changes: number };
    diff.changes;
  `;
  const file = source(text);
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === file.fileName ? file : undefined;
  const program = ts.createProgram([file.fileName], { noLib: true }, host);
  expect(changeCountSites(file, program.getTypeChecker()).map(site => site.line)).toEqual([5]);
});

it('fails every raw site outside db, naming each, and passes a file with none', () => {
  const call = 'db.prepare(sql);';
  expect(boundaryViolations(inventory(call))).toEqual([
    'core/example.ts: boundary sites at line 1 (prepare); move SQL and store execution into db/',
  ]);
  expect(boundaryViolations(inventory(call + call))).toEqual([
    'core/example.ts: boundary sites at line 1 (prepare), line 1 (prepare); move SQL and store execution into db/',
  ]);
  expect(boundaryViolations(inventory(''))).toEqual([]);
  expect(boundaryViolations(inventory('export const fragment = `SELECT id FROM sessions WHERE project_id = ?`;'))).toEqual([
    'core/example.ts: boundary sites at line 1 (sql); move SQL and store execution into db/',
  ]);
});

it('counts store batches, exec and template producers while ignoring comments and RegExp exec', () => {
  const sites = boundarySites(source(`
    // db.prepare(sql); db.batch([]);
    /* export const fragment = 'SELECT id FROM sessions'; */
    db.batch([]); env.db.exec(sql); db['prepare'](sql);
    export const fragment = \`FROM sessions WHERE id = \${id}\`;
    /words/.exec(text); pattern.exec(text);
  `));
  expect(sites.map(site => site.kind)).toEqual(['batch', 'exec', 'prepare', 'sql']);
});

it('reads a statement or a composed fragment as SQL, and a keyword in prose or copy as words', () => {
  const sql = ["UPDATE t AS a SET x = 1", "UPDATE OR IGNORE t AS a SET x = 1", "/* note */ -- more\nDELETE FROM t", "PRAGMA foreign_keys", "CREATE INDEX i ON t(x)", "WHERE a = ?1 AND b = ?2"];
  const words = ["DELETE", "delete", "update names columns it may not set", "Run now or later?", "Create a project?"];
  for (const text of sql) expect(boundarySites(source(`const a = ${JSON.stringify(text)};`)).map(site => site.kind), text).toEqual(['sql']);
  for (const text of words) expect(boundarySites(source(`const a = ${JSON.stringify(text)};`)), text).toEqual([]);
});

it('recognizes store aliases by their type and permits unrelated batch and exec methods', () => {
  const text = `
    interface Store { prepare(sql: string): unknown; batch(items: unknown[]): void; }
    declare const connection: Store;
    const alias = connection;
    alias.batch([]);
    declare const pattern: { exec(text: string): unknown };
    pattern.exec('ordinary text');
    declare const unrelated: { batch(): void };
    unrelated.batch();
  `;
  const file = source(text);
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === file.fileName ? file : undefined;
  const program = ts.createProgram([file.fileName], { noLib: true }, host);
  expect(boundarySites(file, program.getTypeChecker()).map(site => site.kind)).toEqual(['batch']);
});

it('refuses SQL supplied by a bind-time composition callback', () => {
  expect(()=>Reflect.apply(write,undefined,[{name:'boundary.dynamicSql',sql:(condition:string)=>({sql:condition,values:[]})}]))
    .toThrow('statement SQL must be fixed at definition');
  if(false) {
    // @ts-expect-error Statement text is fixed in the definition, never supplied at bind.
    write({name:'boundary.typedDynamicSql',sql:(condition:string)=>({sql:condition,values:[]})});
  }
});

import { write } from '@myco-server-worker/db/index.js';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { boundaryInventory, boundarySites, boundaryViolations, changeCountInventory, changeCountSites, changeCountViolations, gatedSites, staleStoreAllowances } from './helpers/db-boundary.js';

/**
 * Files still allowed raw SQL or direct store calls. The coordinator owns this set: a lane only removes a file once it
 * has no site left, and the gate fails until it does. A file outside the set with any site fails, naming each site.
 */
const PENDING: ReadonlySet<string> = new Set([
  'auth/device.ts',
  'auth/tokens.ts',
  'core/backup.ts',
  'core/content-budget.ts',
  'core/harness.ts',
  'core/runner-updates.ts',
  'ingest/document-batch.ts',
  'ingest/document-restore.ts',
  'ingest/document-summaries.ts',
  'mcp/definitions.ts',
  'platform/bun/env.ts',
  'read/catalog/children.ts',
  'read/catalog/embedding.ts',
  'read/catalog/hook-placement.ts',
  'read/catalog/lineage.ts',
  'read/catalog/processed.ts',
  'read/catalog/sessions.ts',
  'read/catalog/shared.ts',
  'read/catalog/turns.ts',
  'read/document-catalog.ts',
  'read/runs.ts',
  // Direct store calls inside db/, each waiting on the batch or composed SQL it carries.
  'db/runs/change.ts', // A terminal run update commits with the credential retirement auth/tokens still prepares.
]);

/** Files still deciding an outcome from a statement's change count; same ownership as PENDING. Decide from RETURNING or an in-batch assertion, then remove the file. */
const PENDING_CHANGE_COUNTS: ReadonlySet<string> = new Set([
  'api/member-projects.ts',
]);

const source = (text: string) => ts.createSourceFile('core/example.ts', text, ts.ScriptTarget.Latest, true);
const inventory = (text: string) => new Map([['core/example.ts', boundarySites(source(text))]]);

it('keeps SQL producers and store execution inside db, with a shrinking set of temporary exceptions', () => {
  const root = fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url));
  expect(boundaryViolations(boundaryInventory(root), PENDING)).toEqual([]);
});

it('names only allowances that still reach the store', () => {
  expect(staleStoreAllowances(fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url)))).toEqual([]);
});

it('counts direct store calls inside db but not SQL text, and leaves allowed and frozen files alone', () => {
  const sites = boundarySites(source('db.prepare(sql); db.batch([]); const text = `SELECT id FROM runs WHERE id = ?`; prepareBound(db, bound);'));
  expect(gatedSites('db/runs/example.ts', sites).map(site => site.kind)).toEqual(['prepare', 'batch']);
  expect(gatedSites('db/kernel/commit.ts', sites)).toEqual([]);
  expect(gatedSites('db/schema-v117.ts', sites)).toEqual([]);
  expect(boundaryViolations(new Map([['db/runs/example.ts', gatedSites('db/runs/example.ts', sites)]]), new Set())).toEqual([
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

it('keeps change-count reads to the store adapters, with a shrinking set of temporary exceptions', () => {
  const root = fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url));
  expect(changeCountViolations(changeCountInventory(root), PENDING_CHANGE_COUNTS)).toEqual([]);
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
  expect(changeCountViolations(reads, new Set())).toEqual([
    'core/example.ts: .meta.changes reads at line 3 (changes), line 4 (changes), line 5 (changes), line 6 (changes), line 7 (changes); decide the outcome from a RETURNING row or an in-batch assertion',
  ]);
  expect(changeCountViolations(reads, new Set(['core/example.ts']))).toEqual([]);
  expect(changeCountViolations(new Map([['core/example.ts', []]]), new Set(['core/example.ts']))).toEqual([
    'core/example.ts: no .meta.changes reads left; remove it from PENDING_CHANGE_COUNTS',
  ]);
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

it('fails a raw site in a file outside the set, and a listed file with no site left, but not a listed file that keeps some', () => {
  const call = 'db.prepare(sql);';
  expect(boundaryViolations(inventory(call), new Set())).toEqual([
    'core/example.ts: boundary sites at line 1 (prepare); move SQL and store execution into db/',
  ]);
  const listed = new Set(['core/example.ts']);
  expect(boundaryViolations(inventory(call + call), listed)).toEqual([]);
  expect(boundaryViolations(inventory(''), listed)).toEqual(['core/example.ts: no boundary sites left; remove it from PENDING']);
  expect(boundaryViolations(new Map(), new Set(['core/deleted.ts']))).toEqual(['core/deleted.ts: no boundary sites left; remove it from PENDING']);
  expect(boundaryViolations(inventory('export const fragment = `SELECT id FROM sessions WHERE project_id = ?`;'), new Set())).toEqual([
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

it('reads a lone statement keyword or a sentence opening with one as words and not as SQL', () => {
  expect(boundarySites(source(`const method = 'DELETE'; const op = "delete"; const note = 'update names columns it may not set'; const q = \`WITH recent AS (SELECT 1) SELECT 2\`;`)).map(site => site.kind)).toEqual(['sql']);
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

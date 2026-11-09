import { write } from '@myco-server-worker/db/index.js';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { boundaryInventory, boundarySites, boundaryViolations, changeCountInventory, changeCountSites, changeCountViolations, gatedSites, staleStoreAllowances } from './helpers/db-boundary.js';

const PENDING: ReadonlyMap<string, number> = new Map([
  ['api/runners.ts', 1],
  ['api/runs.ts', 4],
  ['auth/authorization.ts', 3],
  ['auth/device.ts', 21],
  ['auth/grants.ts', 22],
  ['auth/identity-link.ts', 2],
  ['auth/members-admin.ts', 10],
  ['auth/runners.ts', 84],
  ['auth/tokens.ts', 13],
  ['content/document-reader.ts', 9],
  ['content/session-pages.ts', 12],
  ['content/session-turns.ts', 14],
  ['content/tool-statistics.ts', 15],
  ['core/activity.ts', 3],
  ['core/archive-bundle.ts', 44],
  ['core/attempt-accounting.ts', 6],
  ['core/backup.ts', 59],
  ['core/blob-objects.ts', 1],
  ['core/budget-estimates.ts', 3],
  ['core/canopy.ts', 2],
  ['core/content-budget.ts', 3],
  ['core/context-writes.ts', 4],
  ['core/embedding/policy.ts', 1],
  ['core/event-content-restore.ts', 6],
  ['core/event-content.ts', 15],
  ['core/extraction-acks.ts', 2],
  ['core/first-owner.ts', 6],
  ['core/harness-health.ts', 2],
  ['core/harness.ts', 2],
  ['core/injection.ts', 2],
  ['core/learning-hold.ts', 3],
  ['core/learning-sessions.ts', 47],
  ['core/learning-stages.ts', 7],
  ['core/legacy-workers.ts', 6],
  ['core/machine-settings.ts', 39],
  ['core/model-catalogs.ts', 13],
  ['core/object-release.ts', 13],
  ['core/ownership.ts', 8],
  ['core/processed-resources.ts', 2],
  ['core/provenance.ts', 11],
  ['core/pulled-stages.ts', 4],
  ['core/raw-archive.ts', 32],
  ['core/raw-backfill.ts', 19],
  ['core/raw-claims.ts', 23],
  ['core/raw-provenance.ts', 5],
  ['core/raw-resources.ts', 6],
  ['core/recall.ts', 2],
  ['core/recovered-tenant.ts', 18],
  ['core/recovery-forget.ts', 4],
  ['core/recovery-schema.ts', 3],
  ['core/registered-content.ts', 6],
  ['core/relational-snapshot.ts', 17],
  ['core/release-provenance.ts', 12],
  ['core/remotes.ts', 6],
  ['core/repositories.ts', 2],
  ['core/restore-authorization.ts', 6],
  ['core/restore-rows.ts', 7],
  ['core/run-write-store.ts', 2],
  ['core/runner-updates.ts', 22],
  ['core/scheduled-tasks.ts', 1],
  ['core/secrets.ts', 4],
  ['core/session-artifacts.ts', 8],
  ['core/settings.ts', 29],
  ['core/sql-statements.ts', 2],
  ['core/task-catalogue.ts', 1],
  ['core/tombstones.ts', 35],
  ['core/turn-card-prompt.ts', 1],
  ['core/turn-cards.ts', 17],
  ['core/worker-contacts.ts', 28],
  ['core/worker-lease.ts', 2],
  ['core/write-guard-store.ts', 4],
  ['ingest/artifact-record.ts', 2],
  ['ingest/card-settle.ts', 2],
  ['ingest/document-admission.ts', 2],
  ['ingest/document-batch.ts', 57],
  ['ingest/document-restore.ts', 23],
  ['ingest/document-summaries.ts', 38],
  ['ingest/document-text.ts', 2],
  ['ingest/events.ts', 25],
  ['ingest/live-credential.ts', 4],
  ['ingest/parse.ts', 3],
  ['ingest/projections.ts', 48],
  ['ingest/projects.ts', 2],
  ['ingest/publish.ts', 5],
  ['ingest/retention.ts', 8],
  ['ingest/session-edits.ts', 2],
  ['ingest/turns.ts', 6],
  ['ingest/uncaptured.ts', 8],
  ['mcp/definitions.ts', 1],
  ['platform/bun/env.ts', 1],
  ['read/blobs.ts', 2],
  ['read/canopy.ts', 2],
  ['read/capture.ts', 9],
  ['read/catalog/activity.ts', 2],
  ['read/catalog/children.ts', 2],
  ['read/catalog/embedding.ts', 4],
  ['read/catalog/hook-placement.ts', 10],
  ['read/catalog/injection-served-items.ts', 2],
  ['read/catalog/injection.ts', 4],
  ['read/catalog/learning-sessions.ts', 3],
  ['read/catalog/lineage.ts', 4],
  ['read/catalog/plans.ts', 9],
  ['read/catalog/processed.ts', 2],
  ['read/catalog/release-provenance.ts', 7],
  ['read/catalog/search-index.ts', 4],
  ['read/catalog/search.ts', 13],
  ['read/catalog/session-activity.ts', 5],
  ['read/catalog/sessions.ts', 38],
  ['read/catalog/shared.ts', 1],
  ['read/catalog/turns.ts', 3],
  ['read/credentials.ts', 2],
  ['read/document-catalog.ts', 10],
  ['read/legacy-history.ts', 8],
  ['read/machines.ts', 12],
  ['read/repository-requirements.ts', 2],
  ['read/run-outcome.ts', 2],
  ['read/runs.ts', 11],
  ['read/scope.ts', 2],
  ['read/session-artifacts.ts', 2],
  ['read/session-commits.ts', 2],
  ['read/session-files.ts', 4],
  ['read/task-descriptions.ts', 1],
  ['read/transcript.ts', 10],
  ['read/uncaptured.ts', 5],
  ['routes.ts', 4],
  // Direct store calls inside db/, each waiting on the batch or composed SQL it carries.
  ['db/meta/budget-estimates.ts', 3], // A restore's guard is composed from the columns of the rows it replaces.
  ['db/runs/attribution.ts', 1], // Learning completion passes companions core still composes.
  ['db/runs/change.ts', 2], // A run update's column set varies with the caller; its companions are core statements.
  ['db/storage/cleanup.ts', 1], // A page commits core/archive-bundle statements.
]);

/** Reads of a statement's change count awaiting their slice: decide from RETURNING or an in-batch assertion, then lower the count. */
const PENDING_CHANGE_COUNTS: ReadonlyMap<string, number> = new Map([
  ['api/member-projects.ts', 3],
  ['auth/runners.ts', 3],
  ['core/archive-bundle.ts', 2],
  ['core/backup.ts', 1],
  ['core/event-content.ts', 1],
  ['core/machine-settings.ts', 3],
  ['core/model-catalogs.ts', 3],
  ['core/object-release.ts', 3],
  ['core/raw-archive.ts', 2],
  ['core/raw-claims.ts', 1],
  ['core/recovery-forget.ts', 1],
  ['core/release-provenance.ts', 3],
  ['core/remotes.ts', 1],
  ['core/worker-contacts.ts', 3],
  ['ingest/retention.ts', 1],
  ['ingest/uncaptured.ts', 1],
]);

const source = (text: string) => ts.createSourceFile('core/example.ts', text, ts.ScriptTarget.Latest, true);
const inventory = (text: string) => new Map([['core/example.ts', boundarySites(source(text))]]);

it('keeps SQL producers and store execution inside db, with exact temporary exceptions', () => {
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
  expect(boundaryViolations(new Map([['db/runs/example.ts', gatedSites('db/runs/example.ts', sites)]]), new Map())).toEqual([
    'db/runs/example.ts: 2 new direct store calls; use a kernel definition and commit',
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

it('keeps change-count reads to the store adapters, with exact temporary exceptions', () => {
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
  const grown = new Map([['core/example.ts', sites]]);
  expect(changeCountViolations(grown, new Map())).toEqual(['core/example.ts: 5 new .meta.changes reads; decide the outcome from a RETURNING row or an in-batch assertion']);
  expect(changeCountViolations(grown, new Map([['core/example.ts', 4]]))[0]).toContain('5 .meta.changes reads, expected exactly 4');
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

it('catches a new prepare call, growth, stale counts and exported SQL fragments', () => {
  const call = 'db.prepare(sql);';
  expect(boundaryViolations(inventory(call), new Map())).toEqual([
    'core/example.ts: 1 new boundary sites; move SQL and store execution into db/',
  ]);
  const pending = new Map([['core/example.ts', 1]]);
  expect(boundaryViolations(inventory(call + call), pending)[0]).toContain('2 boundary sites, expected exactly 1');
  expect(boundaryViolations(inventory(''), pending)[0]).toContain('0 boundary sites, expected exactly 1');
  expect(boundaryViolations(inventory(''), new Map([['core/example.ts', 0]]))).toHaveLength(1);
  expect(boundaryViolations(inventory('export const fragment = `SELECT id FROM sessions WHERE project_id = ?`;'), new Map())[0]).toContain('1 new boundary sites');
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

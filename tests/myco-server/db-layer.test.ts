import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { boundaryInventory, boundarySites, boundaryViolations } from './helpers/db-boundary.js';

const PENDING: ReadonlyMap<string, number> = new Map([
  ['api/runners.ts', 1],
  ['api/runs.ts', 4],
  ['auth/authorization.ts', 13],
  ['auth/device.ts', 28],
  ['auth/enrollment.ts', 34],
  ['auth/grants.ts', 24],
  ['auth/http-authorization.ts', 14],
  ['auth/identity-link.ts', 21],
  ['auth/join.ts', 3],
  ['auth/mcp-authorization.ts', 6],
  ['auth/member-write-store.ts', 2],
  ['auth/members-admin.ts', 21],
  ['auth/runners.ts', 85],
  ['auth/tokens.ts', 33],
  ['content/document-reader.ts', 9],
  ['content/session-pages.ts', 12],
  ['content/session-turns.ts', 14],
  ['content/tool-statistics.ts', 15],
  ['core/activity.ts', 4],
  ['core/archive-bundle.ts', 44],
  ['core/attempt-accounting.ts', 8],
  ['core/attention-state.ts', 4],
  ['core/backup-retention.ts', 2],
  ['core/backup.ts', 67],
  ['core/blob-objects.ts', 1],
  ['core/blob-references.ts', 3],
  ['core/budget-estimates.ts', 24],
  ['core/canopy.ts', 4],
  ['core/content-budget.ts', 3],
  ['core/content-registration.ts', 2],
  ['core/context-writes.ts', 4],
  ['core/embedding/due.ts', 18],
  ['core/embedding/hubness.ts', 61],
  ['core/embedding/jobs.ts', 4],
  ['core/embedding/policy.ts', 1],
  ['core/embedding/provider-state.ts', 8],
  ['core/embedding/reconcile.ts', 34],
  ['core/embedding/switch-store.ts', 20],
  ['core/embedding/work-state.ts', 8],
  ['core/embedding/work.ts', 2],
  ['core/event-content-restore.ts', 6],
  ['core/event-content.ts', 15],
  ['core/extraction-acks.ts', 2],
  ['core/first-owner.ts', 9],
  ['core/harness-health.ts', 2],
  ['core/harness.ts', 2],
  ['core/injection.ts', 2],
  ['core/jobs-run.ts', 1],
  ['core/learning-hold.ts', 3],
  ['core/learning-sessions.ts', 57],
  ['core/learning-stages.ts', 12],
  ['core/legacy-workers.ts', 6],
  ['core/machine-settings.ts', 39],
  ['core/model-catalogs.ts', 13],
  ['core/object-release.ts', 105],
  ['core/ownership.ts', 46],
  ['core/processed-resources.ts', 2],
  ['core/provenance.ts', 11],
  ['core/pulled-stages.ts', 9],
  ['core/queue-heads.ts', 4],
  ['core/raw-archive.ts', 32],
  ['core/raw-backfill.ts', 19],
  ['core/raw-claims.ts', 23],
  ['core/raw-provenance.ts', 7],
  ['core/raw-resources.ts', 6],
  ['core/recall.ts', 2],
  ['core/recovered-tenant.ts', 18],
  ['core/recovery-forget.ts', 4],
  ['core/recovery-schema.ts', 3],
  ['core/registered-content.ts', 25],
  ['core/relational-snapshot.ts', 17],
  ['core/release-provenance.ts', 12],
  ['core/remotes.ts', 6],
  ['core/repositories.ts', 2],
  ['core/restore-authorization.ts', 6],
  ['core/restore-rows.ts', 7],
  ['core/run-budget.ts', 9],
  ['core/run-steps.ts', 9],
  ['core/run-write-store.ts', 2],
  ['core/runner-updates.ts', 22],
  ['core/runs.ts', 171],
  ['core/scheduled-tasks.ts', 1],
  ['core/secrets.ts', 6],
  ['core/served-material.ts', 11],
  ['core/session-artifacts.ts', 8],
  ['core/settings.ts', 31],
  ['core/spore-curation.ts', 127],
  ['core/spores.ts', 48],
  ['core/sql-statements.ts', 2],
  ['core/storage-cleanup.ts', 26],
  ['core/store-maintenance.ts', 7],
  ['core/task-catalogue.ts', 1],
  ['core/tombstones.ts', 35],
  ['core/transcript-ranges.ts', 5],
  ['core/turn-card-prompt.ts', 1],
  ['core/turn-cards.ts', 25],
  ['core/worker-claim.ts', 7],
  ['core/worker-contacts.ts', 33],
  ['core/worker-lease.ts', 2],
  ['core/write-guard-store.ts', 3],
  ['ingest/artifact-record.ts', 2],
  ['ingest/blobs.ts', 24],
  ['ingest/card-settle.ts', 6],
  ['ingest/document-admission.ts', 2],
  ['ingest/document-batch.ts', 66],
  ['ingest/document-read-failures.ts', 4],
  ['ingest/document-restore.ts', 23],
  ['ingest/document-summaries.ts', 38],
  ['ingest/document-text.ts', 2],
  ['ingest/events.ts', 25],
  ['ingest/live-credential.ts', 4],
  ['ingest/parse.ts', 10],
  ['ingest/projections.ts', 59],
  ['ingest/projects.ts', 2],
  ['ingest/prompt-scheme.ts', 8],
  ['ingest/publish.ts', 29],
  ['ingest/record-scheme.ts', 2],
  ['ingest/retention.ts', 8],
  ['ingest/session-edits.ts', 2],
  ['ingest/turns.ts', 6],
  ['ingest/uncaptured.ts', 10],
  ['mcp/definitions.ts', 1],
  ['platform/bun/env.ts', 1],
  ['read/blobs.ts', 4],
  ['read/budget.ts', 4],
  ['read/canopy.ts', 2],
  ['read/capture.ts', 9],
  ['read/catalog/activity.ts', 2],
  ['read/catalog/children.ts', 15],
  ['read/catalog/embedding-hubness.ts', 25],
  ['read/catalog/embedding-reconcile.ts', 17],
  ['read/catalog/embedding-selection.ts', 10],
  ['read/catalog/embedding-source-state.ts', 1],
  ['read/catalog/embedding-switch-store.ts', 10],
  ['read/catalog/embedding-work-sweep.ts', 12],
  ['read/catalog/embedding.ts', 4],
  ['read/catalog/extraction-coverage.ts', 2],
  ['read/catalog/hook-placement.ts', 10],
  ['read/catalog/injection-served-items.ts', 2],
  ['read/catalog/injection.ts', 4],
  ['read/catalog/learning-sessions.ts', 3],
  ['read/catalog/lineage.ts', 4],
  ['read/catalog/plans.ts', 11],
  ['read/catalog/processed.ts', 2],
  ['read/catalog/prompts.ts', 2],
  ['read/catalog/release-provenance.ts', 7],
  ['read/catalog/search-index.ts', 7],
  ['read/catalog/search.ts', 13],
  ['read/catalog/session-activity.ts', 5],
  ['read/catalog/sessions.ts', 39],
  ['read/catalog/shared.ts', 1],
  ['read/catalog/turns.ts', 3],
  ['read/credentials.ts', 4],
  ['read/document-catalog.ts', 12],
  ['read/document-status.ts', 8],
  ['read/fleet.ts', 2],
  ['read/legacy-history.ts', 8],
  ['read/machines.ts', 12],
  ['read/material-readiness.ts', 4],
  ['read/meta.ts', 6],
  ['read/repository-requirements.ts', 2],
  ['read/run-outcome.ts', 2],
  ['read/run-reads.ts', 26],
  ['read/runs.ts', 27],
  ['read/scope.ts', 2],
  ['read/session-artifacts.ts', 2],
  ['read/session-commits.ts', 2],
  ['read/session-files.ts', 4],
  ['read/sessions.ts', 4],
  ['read/task-descriptions.ts', 1],
  ['read/task-start.ts', 2],
  ['read/transcript.ts', 10],
  ['read/uncaptured.ts', 5],
  ['read/work.ts', 25],
  ['routes.ts', 4],
]);

const source = (text: string) => ts.createSourceFile('core/example.ts', text, ts.ScriptTarget.Latest, true);
const inventory = (text: string) => new Map([['core/example.ts', boundarySites(source(text))]]);

it('keeps SQL producers and store execution inside db, with exact temporary exceptions', () => {
  const root = fileURLToPath(new URL('../../packages/myco-server/src', import.meta.url));
  expect(boundaryViolations(boundaryInventory(root), PENDING)).toEqual([]);
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

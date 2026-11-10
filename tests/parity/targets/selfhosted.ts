import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import {PARITY_PULLED_STAGES} from '../../helpers/pulled-test-stage.ts';
import {installPulledStages} from '@myco-server-worker/core/pulled-stages.js';
import {checkObservedRelease,primeObservedEmbedding,installObservedEmbeddingRuntime} from '../observed-worker.ts';
import { wordVectorProvider } from '../embedding/word-vectors.ts';
import { revisionHeaders } from '../settings-revision.ts';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '../../myco-server/helpers/member-token.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { linkStatement } from '@myco-server-worker/auth/identity-link.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { createBunHandler, serve, type BunServerOptions } from '@myco-server-worker/entry/bun.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { GITHUB_SUB, MACHINE_ID, MEMBER_ID, PROJECT_ID, SESSION_SECRET, grantHeadersFor, lit, memberHeadersFor, volumeSql, type ParityTarget } from '../harness.ts';
import { stopRaceFixture } from '../owner-review/stop-race.ts';
import { receiptSnapshotEndpoint } from '../receipt-snapshots/endpoint.ts';
import {statementRecorder,observeStatementSpans,withStatementSpan,type StatementFrame} from '../../helpers/statement-recorder.js';
import { upgradeNativeStore } from '../schema-carry.ts';
import { seedDeployment } from '../upgrade-seed/index.ts';

/** The shipped self-hosted server, in-process: real entry, real migrations, a temp volume. */
export async function bootSelfhosted(options: { stopRace?: boolean; receiptSnapshots?: boolean; pulledStage?: boolean; embeddingFixture?:boolean; latestSchemaUpgrade?: boolean; uiAssets?: BunServerOptions['uiAssets'] } = {}): Promise<ParityTarget> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-'));
  const databasePath = path.join(root, 'myco.sqlite');

  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES (?, ?, 0, NULL)`).run(MEMBER_ID, 'parity');
  // The Project every scenario works in exists from boot, as capture would have created it, so no scenario depends on
  // another having captured into it first.
  sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(PROJECT_ID, PROJECT_ID, Date.now());
  const db = sqliteRelationalStore(sqlite);
  await completeBudgetMigration(db,Date.now());
  await linkStatement(db, MEMBER_ID, GITHUB_SUB).run();
  const { token } = await issueMemberToken(db, { memberId: MEMBER_ID, machineId: MACHINE_ID }, Date.now());
  const deploymentId = String((sqlite.query("SELECT value FROM schema_meta WHERE key = 'deployment_id'").get() as { value?: string } | null)?.value);
  if (!deploymentId || deploymentId === 'undefined') throw new Error('native parity target has no Deployment identity');
  sqlite.close();

  const wrapKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  // The recording launch: the run row takes the recorder's mark and nothing starts, so the queue is proven without a runtime.
  const sql = volumeSql(databasePath);
  const serverOptions: BunServerOptions = {
    harnessLaunch: async (spec) => { await sql(`UPDATE agent_runs SET harness = 'record' WHERE id = ${lit(spec.runId)}`); },
    databasePath,
    blobDir: path.join(root, 'blobs'),
    port: 0,
    bind: 'loopback',
    transport: 'loopback',
    sourceFrom: 'socket',
    wakeLoop: false,
    uiAssets: options.uiAssets,
    originOf: (port) => `http://127.0.0.1:${port}`,
    SESSION_SECRET,
    SECRET_WRAP_KEY: wrapKey,
    GITHUB_CLIENT_ID: 'parity-client',
    GITHUB_CLIENT_SECRET: 'parity-secret',
  };
  const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: deploymentId, sub: GITHUB_SUB, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
  // The embedding endpoint a Deployment seeded for an upgrade recalls through, for as long as the target runs.
  const provider = options.latestSchemaUpgrade === true ? wordVectorProvider() : null;
  if (provider !== null) {
    // The Deployment's users write at the latest schema; their rows are carried to the last release's schema, which the self-hosted migrator upgrades.
    try {
      const seeding = await serve(serverOptions);
      try {
        const url = `http://127.0.0.1:${seeding.port}`;
        // The owner points the Deployment at the embedding endpoint, so what members save is recalled into their prompts.
        const body = { provider: 'ollama', model: 'parity-words', endpoint: provider.origin };
        const headers = await revisionHeaders({ url, ownerHeaders: () => ({ cookie }) }, '/api/embedding', body);
        const embedding = await fetch(`${url}/api/embedding`, { method: 'PUT', headers: { cookie, origin: url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        if (embedding.status !== 200) throw new Error(`the native seed could not configure embeddings: ${embedding.status} ${await embedding.text()}`);
        await seedDeployment({ url, projectId: PROJECT_ID, deploymentId, sql, ownerHeaders: () => ({ cookie }), memberHeaders: (extra = {}) => memberHeadersFor(token, PROJECT_ID, extra),
          primeEmbedding: (projectId) => primeObservedEmbedding(seeding.env, projectId), checkRelease: () => checkObservedRelease(seeding.env) });
        await seeding.env.settle();
      } finally { await seeding.stop(); }
      upgradeNativeStore(databasePath);
    } catch (error) { provider.stop(); throw error; }
  }
  const started = options.stopRace === true || options.receiptSnapshots === true || options.pulledStage===true ? await (async () => {
    const handler = await createBunHandler(serverOptions);
    const restoreStages = options.pulledStage === true ? installPulledStages(PARITY_PULLED_STAGES) : () => {};
    const race = stopRaceFixture();
    if (options.stopRace === true) handler.env.db = race.wrap(handler.env.db);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false,
      fetch: async (request) => options.receiptSnapshots === true
        ? await receiptSnapshotEndpoint(request, handler.env.db) ?? handler.fetch(request)
        : await race.endpoint(request) ?? handler.fetch(request),
      error: () => new Response(null, { status: 503 }),
    });
    handler.bind(server);
    return { port: server.port, env: handler.env, stop: async () => { server.stop(); await handler.close(); restoreStages(); } };
  })() : await serve(serverOptions);
  const recorded=statementRecorder(started.env.db,{accounting:'native'});
  started.env.db=recorded.db;
  const settleEmbedding=options.embeddingFixture?installObservedEmbeddingRuntime(started.env):async()=>{};
  const spans:StatementFrame[]=[];
  const stopObservingSpans=observeStatementSpans(frame=>spans.push(frame));
  const url = `http://127.0.0.1:${started.port}`;

  return {
    name: 'selfhosted',
    url,
    deploymentId,
    bindings: { database: databasePath, blob: path.join(root, 'blobs'), secret: await sha256Hex(wrapKey), vector: databasePath },
    memberToken: token,
    projectId: PROJECT_ID,
    ownerHeaders: () => ({ cookie }),
    memberHeaders: (extra = {}) => memberHeadersFor(token, PROJECT_ID, extra),
    grantHeaders: (key) => grantHeadersFor(key),
    sql,
    clockWake: async (at=Date.now()) => { await withStatementSpan('native.clockWake','clock',()=>runTick(started.env, at, { wake: 'clock' })); },
    primeEmbedding:async(projectId)=>{await withStatementSpan('native.embedding-fixture','direct',()=>primeObservedEmbedding(started.env,projectId));},
    readTrace:async()=>{
      await settleEmbedding();await started.env.settle();await recorded.drain();
      const trace={events:structuredClone(recorded.events),statements:structuredClone(recorded.statements),spans:spans.splice(0),constructors:[]};
      recorded.reset();return trace;
    },
    stop: async () => {
      try{await started.stop();}
      finally{provider?.stop();stopObservingSpans();fs.rmSync(root, { recursive: true, force: true });}
    },
  };
}

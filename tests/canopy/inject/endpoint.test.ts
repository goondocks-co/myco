import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';
import { createCanopyInjectHandler } from '@myco/daemon/api/canopy-inject';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId } from '@myco/grove/ids';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import {
  _resetPendingInjections,
  consumePendingInjection,
} from '@myco/canopy/inject/pending';

const NOW = Math.floor(Date.now() / 1000);

interface SeedEntry {
  path: string;
  size: number;
  topComment?: string | null;
  exports?: string[];
  imports?: string[];
  llmDescription?: string | null;
  llmUpdatedAt?: number | null;
}

function seed(projectId: string, entries: SeedEntry[]): void {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO canopy_entries (
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at
     ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of entries) {
    stmt.run(
      projectId,
      e.path,
      'h'.repeat(64),
      e.size,
      Math.ceil(e.size / 4),
      Math.ceil(e.size / 40),
      'typescript',
      JSON.stringify(e.exports ?? []),
      JSON.stringify(e.imports ?? []),
      e.topComment ?? null,
      NOW,
      e.llmDescription ?? null,
      e.llmUpdatedAt ?? null,
    );
  }
}

function makeConfig(overrides: Partial<{ inject_on_pre_tool_use: boolean; min_file_bytes: number }> = {}): MycoConfig {
  const cfg = MycoConfigSchema.parse({ version: 3 });
  if ('inject_on_pre_tool_use' in overrides) {
    cfg.cortex.canopy.inject_on_pre_tool_use = overrides.inject_on_pre_tool_use!;
  }
  if ('min_file_bytes' in overrides) {
    cfg.cortex.canopy.min_file_bytes = overrides.min_file_bytes!;
  }
  return cfg;
}

let tmpVault: string;
let tmpProjectId: string;

/**
 * The caller-supplied request context every handler call gets. The handler
 * derives tenancy from this — NOT from a daemon bootstrap-anchor vault — so
 * tests must provide it explicitly (the daemon resolves and authorizes it
 * before dispatch in production). See tests/meta/no-anchor-as-tenancy.test.ts.
 */
function ctx(overrides: Partial<MycoRequestContext> = {}): MycoRequestContext {
  return {
    projectRoot: tmpVault,
    callerRoot: null,
    projectId: assertGroveProjectId(tmpProjectId),
    groveId: null,
    machineId: 'local',
    sessionId: null,
    projectVaultDir: path.join(tmpVault, '.myco'),
    databasePath: path.join(tmpVault, '.myco', SQLITE_DB_FILE),
    source: 'explicit',
    tenancySource: 'caller',
    ...overrides,
  };
}

beforeEach(() => {
  closeDatabase();
  _resetPendingInjections();
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-inject-'));
  fs.mkdirSync(path.join(tmpVault, '.myco'), { recursive: true });
  const manifest = ensureProjectManifest(path.join(tmpVault, '.myco'), { projectName: 'canopy-inject' });
  tmpProjectId = manifest.project.id;
  initDatabase(path.join(tmpVault, '.myco', SQLITE_DB_FILE));
  createSchema(getDatabase(), 'local');
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('POST /canopy/inject — handler', () => {
  it('rejects an invalid request body with 400', async () => {
    const cfg = makeConfig();
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      getDatabase,
    });
    const res = await handler({ body: { not: 'valid' } });
    expect(res.status).toBe(400);
  });

  it('returns capability_off for unknown agent', async () => {
    const cfg = makeConfig();
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'definitely-not-real',
        toolInput: { file_path: 'foo.ts' },
      },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'capability_off' });
  });

  it('returns capability_off for cursor (no preToolUseInjection)', async () => {
    const cfg = makeConfig();
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: { sessionId: 's1', agent: 'cursor', toolInput: { file_path: 'foo.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'capability_off' });
  });

  it('returns disabled when cortex.canopy.inject_on_pre_tool_use is false', async () => {
    const cfg = makeConfig({ inject_on_pre_tool_use: false });
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: { sessionId: 's1', agent: 'claude-code', toolInput: { file_path: 'foo.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'disabled' });
  });

  // HTTP-server setup compounds under full-suite event-loop contention; raise the
  // 5s default so it doesn't fire before the assertion runs. See issue #287.
  it('returns targeted when offset is set', async () => {
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'foo.ts', offset: 100 },
      },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'targeted' });
  }, 15_000);

  it('returns unknown_file when path is not in canopy_entries', async () => {
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'never/scanned.ts' },
      },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'unknown_file' });
  });

  it('returns small_file when entry size_bytes is below threshold', async () => {
    const projectId = tmpProjectId;
    seed(projectId, [{ path: 'tiny.ts', size: 200 }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: { sessionId: 's1', agent: 'claude-code', toolInput: { file_path: 'tiny.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'small_file' });
  });

  it('injects when all gates pass and records pending injection tokens', async () => {
    const projectId = tmpProjectId;
    seed(projectId, [
      {
        path: 'src/big.ts',
        size: 4096,
        exports: ['handleSessionStart', 'SessionStartPayload'],
        imports: ['./capture/buffer'],
        topComment: 'Handles SessionStart lifecycle events.',
      },
    ]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'src/big.ts' },
      },
    });
    expect(res.body).toMatchObject({
      inject: true,
      path: 'src/big.ts',
    });
    const body = res.body as { blob: string; injectionTokens: number };
    expect(body.blob).toContain('[canopy] src/big.ts');
    expect(body.blob).toContain('handleSessionStart');
    expect(body.injectionTokens).toBeGreaterThan(0);

    // Pending registry recorded the linkage; consume it (this is what
    // the PostToolUse activity-insert path does).
    const pending = consumePendingInjection('s1', 'src/big.ts');
    expect(pending).toBe(body.injectionTokens);
  });

  it('canonicalizes absolute file_path to repo-relative for lookup', async () => {
    seed(tmpProjectId, [{ path: 'src/big.ts', size: 4096 }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const absPath = path.join(tmpVault, 'src/big.ts');
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: absPath },
      },
    });
    expect(res.body).toMatchObject({ inject: true, path: 'src/big.ts' });
    const body = res.body as { injectionTokens: number };
    expect(consumePendingInjection('s1', absPath)).toBe(body.injectionTokens);
  });

  it('uses requestContext.callerRoot to canonicalize worktree absolute paths', async () => {
    const worktreeRoot = path.join(os.tmpdir(), 'myco-worktree-canopy');
    seed(tmpProjectId, [{ path: 'src/worktree.ts', size: 4096 }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const absoluteWorktreePath = path.join(worktreeRoot, 'src/worktree.ts');
    const res = await handler({
      requestContext: {
        projectRoot: tmpVault,
        callerRoot: worktreeRoot,
        projectId: assertGroveProjectId(tmpProjectId),
        groveId: null,
        machineId: 'local',
        sessionId: 's-worktree',
        projectVaultDir: path.join(tmpVault, '.myco'),
        databasePath: path.join(tmpVault, '.myco', SQLITE_DB_FILE),
        source: 'explicit',
      },
      body: {
        sessionId: 's-worktree',
        agent: 'claude-code',
        toolInput: { file_path: absoluteWorktreePath },
      },
    });

    expect(res.body).toMatchObject({ inject: true, path: 'src/worktree.ts' });
    const body = res.body as { injectionTokens: number };
    expect(consumePendingInjection('s-worktree', absoluteWorktreePath)).toBe(body.injectionTokens);
  });

  it('returns already_injected on the second read of the same file in one session', async () => {
    // Per-(session, file) dedup via recordInjectionActivity. The first call
    // records `myco:inject_canopy` with content_hash
    // `myco:inject:canopy:<sessionId>:<filePath>`; the second collides on
    // the UNIQUE index and surfaces as inject:false / already_injected.
    const { insertBatch } = await import('@myco/db/queries/batches.js');
    const { upsertSession } = await import('@myco/db/queries/sessions.js');
    const NOW_SEC = Math.floor(Date.now() / 1000);
    upsertSession({ id: 's-canopy-dedup', agent: 'claude-code', started_at: NOW_SEC, created_at: NOW_SEC });
    insertBatch({
      session_id: 's-canopy-dedup',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'read big.ts',
      started_at: NOW_SEC,
      created_at: NOW_SEC,
      project_id: tmpProjectId,
    });
    seed(tmpProjectId, [{ path: 'src/big.ts', size: 4096, exports: ['foo'] }]);

    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const first = await handler({
      requestContext: ctx(),
      body: { sessionId: 's-canopy-dedup', agent: 'claude-code', toolInput: { file_path: 'src/big.ts' } },
    });
    expect(first.body).toMatchObject({ inject: true, path: 'src/big.ts' });

    const second = await handler({
      requestContext: ctx(),
      body: { sessionId: 's-canopy-dedup', agent: 'claude-code', toolInput: { file_path: 'src/big.ts' } },
    });
    expect(second.body).toMatchObject({ inject: false, reason: 'already_injected' });
  });

  it('distinct files in one session both inject (discriminator is per-file)', async () => {
    const { insertBatch } = await import('@myco/db/queries/batches.js');
    const { upsertSession } = await import('@myco/db/queries/sessions.js');
    const NOW_SEC = Math.floor(Date.now() / 1000);
    upsertSession({ id: 's-canopy-multi', agent: 'claude-code', started_at: NOW_SEC, created_at: NOW_SEC });
    insertBatch({
      session_id: 's-canopy-multi',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'read a + b',
      started_at: NOW_SEC,
      created_at: NOW_SEC,
      project_id: tmpProjectId,
    });
    seed(tmpProjectId, [
      { path: 'src/a.ts', size: 4096, exports: ['a'] },
      { path: 'src/b.ts', size: 4096, exports: ['b'] },
    ]);

    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const a = await handler({ requestContext: ctx(), body: { sessionId: 's-canopy-multi', agent: 'claude-code', toolInput: { file_path: 'src/a.ts' } } });
    const b = await handler({ requestContext: ctx(), body: { sessionId: 's-canopy-multi', agent: 'claude-code', toolInput: { file_path: 'src/b.ts' } } });
    expect(a.body).toMatchObject({ inject: true, path: 'src/a.ts' });
    expect(b.body).toMatchObject({ inject: true, path: 'src/b.ts' });
  });

  it('no_batch falls through and still serves the blob (preserves legacy behavior)', async () => {
    // PreToolUse can fire before any prompt_batch lands (e.g. agent calls a
    // tool from its own start-up). recordInjectionActivity returns
    // {injected:false, reason:'no_batch'} in that case — the handler must
    // continue and serve the blob, only skipping the activity record.
    seed(tmpProjectId, [{ path: 'src/c.ts', size: 4096, exports: ['c'] }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: { sessionId: 's-canopy-no-batch', agent: 'claude-code', toolInput: { file_path: 'src/c.ts' } },
    });
    expect(res.body).toMatchObject({ inject: true, path: 'src/c.ts' });
  });

  it('uses summary [meta] line when llm_description is populated', async () => {
    seed(tmpProjectId, [
      {
        path: 'src/big.ts',
        size: 4096,
        exports: ['foo'],
        llmDescription: 'A test file used for integration coverage.',
        llmUpdatedAt: NOW,
      },
    ]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      getDatabase,
    });
    const res = await handler({
      requestContext: ctx(),
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'src/big.ts' },
      },
    });
    const body = res.body as { blob: string };
    expect(body.blob).toContain('summary: "A test file used for integration coverage."');
    expect(body.blob).toContain('File summary from Myco');
  });
});

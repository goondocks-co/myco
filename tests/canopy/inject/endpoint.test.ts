import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';
import { createCanopyInjectHandler } from '@myco/daemon/api/canopy-inject';
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

function makeConfig(overrides: Partial<MycoConfig['cortex']['canopy']['injection']> = {}): MycoConfig {
  const cfg = MycoConfigSchema.parse({ version: 3 });
  cfg.cortex.canopy.injection = {
    enabled: true,
    size_threshold: 800,
    ...cfg.cortex.canopy.injection,
    ...overrides,
  };
  return cfg;
}

let tmpVault: string;

beforeEach(() => {
  closeDatabase();
  _resetPendingInjections();
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-inject-'));
  fs.mkdirSync(path.join(tmpVault, '.myco'), { recursive: true });
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
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({ body: { not: 'valid' } });
    expect(res.status).toBe(400);
  });

  it('returns capability_off for unknown agent', async () => {
    const cfg = makeConfig();
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
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
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
      body: { sessionId: 's1', agent: 'cursor', toolInput: { file_path: 'foo.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'capability_off' });
  });

  it('returns disabled when cortex.canopy.injection.enabled is false', async () => {
    const cfg = makeConfig({ enabled: false });
    const handler = createCanopyInjectHandler({
      liveConfig: { current: cfg },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
      body: { sessionId: 's1', agent: 'claude-code', toolInput: { file_path: 'foo.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'disabled' });
  });

  it('returns targeted when offset is set', async () => {
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'foo.ts', offset: 100 },
      },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'targeted' });
  });

  it('returns unknown_file when path is not in canopy_entries', async () => {
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
      body: {
        sessionId: 's1',
        agent: 'claude-code',
        toolInput: { file_path: 'never/scanned.ts' },
      },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'unknown_file' });
  });

  it('returns small_file when entry size_bytes is below threshold', async () => {
    const projectId = tmpVault;
    seed(projectId, [{ path: 'tiny.ts', size: 200 }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
      body: { sessionId: 's1', agent: 'claude-code', toolInput: { file_path: 'tiny.ts' } },
    });
    expect(res.body).toMatchObject({ inject: false, reason: 'small_file' });
  });

  it('injects when all gates pass and records pending injection tokens', async () => {
    const projectId = tmpVault;
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
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
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
    seed(tmpVault, [{ path: 'src/big.ts', size: 4096 }]);
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const absPath = path.join(tmpVault, 'src/big.ts');
    const res = await handler({
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

  it('uses summary [meta] line when llm_description is populated', async () => {
    seed(tmpVault, [
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
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });
    const res = await handler({
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

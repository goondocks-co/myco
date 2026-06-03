import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema } from '@myco/config/schema';
import { createCanopyInjectHandler } from '@myco/daemon/api/canopy-inject';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId } from '@myco/grove/ids';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import {
  _resetPendingInjections,
  consumePendingInjection,
} from '@myco/canopy/inject/pending';

const NOW = Math.floor(Date.now() / 1000);

function seedEntry(projectId: string, p: string, sizeBytes: number): void {
  getDatabase().prepare(
    `INSERT INTO canopy_entries (
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at
     ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    projectId,
    p,
    'h'.repeat(64),
    sizeBytes,
    Math.ceil(sizeBytes / 4),
    Math.ceil(sizeBytes / 40),
    'typescript',
    JSON.stringify(['handleSessionStart']),
    JSON.stringify(['./buffer']),
    'Handles SessionStart lifecycle.',
    NOW,
  );
}

let tmpVault: string;
let tmpProjectId: string;
let server: http.Server | null = null;
let port = 0;

beforeEach(async () => {
  closeDatabase();
  _resetPendingInjections();
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-e2e-'));
  fs.mkdirSync(path.join(tmpVault, '.myco'), { recursive: true });
  tmpProjectId = ensureProjectManifest(path.join(tmpVault, '.myco'), { projectName: 'canopy-e2e' }).project.id;
  initDatabase(path.join(tmpVault, '.myco', SQLITE_DB_FILE));
  createSchema(getDatabase(), 'local');

  const cfg = MycoConfigSchema.parse({ version: 3 });
  const handler = createCanopyInjectHandler({
    liveConfig: { current: cfg },
    getDatabase,
  });

  // The real daemon resolves + authorizes the request context before the
  // handler runs; this minimal harness stands in for that, supplying the
  // caller's tenancy explicitly. The handler must NOT re-derive tenancy from
  // a bootstrap-anchor vault. See tests/meta/no-anchor-as-tenancy.test.ts.
  const requestContext: MycoRequestContext = {
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
  };

  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/canopy/inject') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await handler({ requestContext, body });
      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body));
    });
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  closeDatabase();
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('end-to-end Canopy injection over HTTP', () => {
  it('returns the composed blob and records pending tokens for a Claude Code Read', async () => {
    seedEntry(tmpProjectId, 'src/big.ts', 4096);

    const res = await fetch(`http://127.0.0.1:${port}/canopy/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-e2e',
        agent: 'claude-code',
        toolInput: { file_path: 'src/big.ts' },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      inject: boolean;
      blob: string;
      injectionTokens: number;
      path: string;
    };
    expect(body.inject).toBe(true);
    expect(body.path).toBe('src/big.ts');
    expect(body.blob).toContain('[canopy] src/big.ts');
    expect(body.blob).toContain('handleSessionStart');
    expect(body.blob).toContain('[meta] File anatomy from Myco.');
    expect(body.injectionTokens).toBeGreaterThan(0);

    // Pending registry: a subsequent PostToolUse activity insert would
    // consume this and stamp activities.canopy_injection_tokens.
    expect(consumePendingInjection('sess-e2e', 'src/big.ts')).toBe(body.injectionTokens);
  });

  it('returns inject:false (capability_off) for a non-injection-capable symbiont', async () => {
    seedEntry(tmpProjectId, 'src/big.ts', 4096);

    const res = await fetch(`http://127.0.0.1:${port}/canopy/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-e2e',
        agent: 'cursor',
        toolInput: { file_path: 'src/big.ts' },
      }),
    });
    const body = await res.json() as { inject: boolean; reason: string };
    expect(body.inject).toBe(false);
    expect(body.reason).toBe('capability_off');
    // No pending entry recorded.
    expect(consumePendingInjection('sess-e2e', 'src/big.ts')).toBeNull();
  });

  it('returns inject:false (targeted) when offset is set', async () => {
    seedEntry(tmpProjectId, 'src/big.ts', 4096);

    const res = await fetch(`http://127.0.0.1:${port}/canopy/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-e2e',
        agent: 'claude-code',
        toolInput: { file_path: 'src/big.ts', offset: 100, limit: 50 },
      }),
    });
    const body = await res.json() as { inject: boolean; reason: string };
    expect(body.inject).toBe(false);
    expect(body.reason).toBe('targeted');
  });
});

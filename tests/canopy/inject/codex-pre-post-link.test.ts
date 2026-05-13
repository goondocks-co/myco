import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { initDatabase, closeDatabase, getDatabase, SQLITE_DB_FILE } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema';
import { createCanopyInjectHandler } from '@myco/daemon/api/canopy-inject';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
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

function makeConfig(): MycoConfig {
  const cfg = MycoConfigSchema.parse({ version: 3 });
  cfg.cortex.canopy.inject_on_pre_tool_use = true;
  return cfg;
}

let tmpVault: string;
let tmpProjectId: string;

beforeEach(() => {
  closeDatabase();
  _resetPendingInjections();
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-codex-link-'));
  fs.mkdirSync(path.join(tmpVault, '.myco'), { recursive: true });
  tmpProjectId = ensureProjectManifest(path.join(tmpVault, '.myco'), {
    projectName: 'canopy-codex-link',
  }).project.id;
  initDatabase(path.join(tmpVault, '.myco', SQLITE_DB_FILE));
  createSchema(getDatabase(), 'local');
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpVault, { recursive: true, force: true });
});

describe('Codex Pre→Post linkage records canopy_injection_tokens', () => {
  it('inject=true and pending registry records under entry path', async () => {
    // Phase-2 wiring proof: Codex manifest now has preToolUseInjection: true,
    // so the daemon's capability gate at canopy-inject.ts must accept
    // agent: 'codex' and produce a compose+pending side-effect identical
    // to the Claude Code path.
    seedEntry(tmpProjectId, 'src/example.ts', 4096);

    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });

    const res = await handler({
      body: {
        sessionId: 'codex-sess-1',
        agent: 'codex',
        toolInput: { file_path: 'src/example.ts' },
      },
    });

    expect(res.status ?? 200).toBe(200);
    const body = res.body as {
      inject: boolean;
      path: string;
      blob: string;
      injectionTokens: number;
    };
    expect(body.inject).toBe(true);
    expect(body.path).toBe('src/example.ts');
    expect(body.injectionTokens).toBeGreaterThan(0);

    // First consume returns the recorded token count (this is what the
    // PostToolUse activity insert does to stamp canopy_injection_tokens).
    const consumed = consumePendingInjection('codex-sess-1', 'src/example.ts');
    expect(consumed).toBe(body.injectionTokens);

    // One-shot semantics: a second consume returns null.
    expect(consumePendingInjection('codex-sess-1', 'src/example.ts')).toBeNull();
  });

  it('agent without preToolUseInjection capability gets inject=false reason=capability_off', async () => {
    // The capability gate must still reject symbionts whose manifest does
    // not declare preToolUseInjection. cursor is the canonical example.
    seedEntry(tmpProjectId, 'src/example.ts', 4096);

    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });

    const res = await handler({
      body: {
        sessionId: 'cursor-sess-1',
        agent: 'cursor',
        toolInput: { file_path: 'src/example.ts' },
      },
    });

    expect(res.body).toMatchObject({ inject: false, reason: 'capability_off' });
    // No pending entry recorded — PostToolUse linkage must find nothing.
    expect(consumePendingInjection('cursor-sess-1', 'src/example.ts')).toBeNull();
  });

  it('files smaller than min_file_bytes return inject=false reason=small_file', async () => {
    // Size filter still gates even when the capability is on for Codex.
    seedEntry(tmpProjectId, 'src/tiny.ts', 200);

    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });

    const res = await handler({
      body: {
        sessionId: 'codex-sess-2',
        agent: 'codex',
        toolInput: { file_path: 'src/tiny.ts' },
      },
    });

    expect(res.body).toMatchObject({ inject: false, reason: 'small_file' });
    expect(consumePendingInjection('codex-sess-2', 'src/tiny.ts')).toBeNull();
  });

  it('unknown file path bails cleanly without registering pending entry', async () => {
    // Path is not in canopy_entries — daemon must return unknown_file
    // and must not pollute the pending registry.
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });

    const res = await handler({
      body: {
        sessionId: 'codex-sess-3',
        agent: 'codex',
        toolInput: { file_path: 'src/never-scanned.ts' },
      },
    });

    expect(res.body).toMatchObject({ inject: false, reason: 'unknown_file' });
    expect(consumePendingInjection('codex-sess-3', 'src/never-scanned.ts')).toBeNull();
  });

  it('cold cache: inject=false, reason=unknown_file, no pending entry recorded', async () => {
    // Cold-cache no-op: nothing seeded anywhere. The Codex response.ts path
    // relies on this returning unknown_file (empty stdout, no pending row)
    // so a fresh project doesn't surface a misleading Canopy block.
    const handler = createCanopyInjectHandler({
      liveConfig: { current: makeConfig() },
      vaultDir: path.join(tmpVault, '.myco'),
      getDatabase,
    });

    const res = await handler({
      body: {
        sessionId: 'codex-sess-cold',
        agent: 'codex',
        toolInput: { file_path: 'src/cold.ts' },
      },
    });

    expect(res.body).toMatchObject({ inject: false, reason: 'unknown_file' });
    expect(consumePendingInjection('codex-sess-cold', 'src/cold.ts')).toBeNull();
  });
});

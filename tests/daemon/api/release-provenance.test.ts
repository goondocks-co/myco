// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import {
  insertGitProvenance,
  upsertReleaseState,
} from '@myco/db/queries/release-provenance';
import { upsertSession } from '@myco/db/queries/sessions';
import { insertBatch, PROMPT_BATCH_ORIGIN } from '@myco/db/queries/batches';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import type { RouteRequest } from '@myco/daemon/router';
import type { RequestPrincipal } from '@myco/daemon/request-principal';
import { createReleaseProvenanceHandlers } from '@myco/daemon/api/release-provenance';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeRequest(params: Record<string, string>): RouteRequest {
  return {
    params,
    query: {},
    body: undefined,
    pathname: `/api/release-provenance/${params.namespace}/${params.recordId}`,
  } as RouteRequest;
}

function makePrincipal(projectId = PROJECT_ID): RequestPrincipal {
  return {
    identity: { machineId: 'machine-test', userId: null },
    tenancy: {
      projectVaultDir: '/tmp/project/.myco' as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId,
      groveId: 'grove-test',
    },
  };
}

function makeConfig(overrides: Partial<MycoConfig['release_provenance']> = {}): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3,
    release_provenance: {
      enabled: true,
      production_refs: ['refs/tags/myco/v1.2.5'],
      integration_refs: ['refs/heads/main'],
      github: {
        repo: 'owner/repo',
        token_env: 'MYCO_TEST_GITHUB_TOKEN',
      },
      ...overrides,
    },
  });
}

function seedSession(id: string, now: number): void {
  upsertSession({
    id,
    project_id: PROJECT_ID,
    agent: 'codex',
    started_at: now - 100,
    created_at: now - 100,
  });
}

function seedBatch(sessionId: string, now: number): number {
  return insertBatch({
    session_id: sessionId,
    project_id: PROJECT_ID,
    origin: PROMPT_BATCH_ORIGIN.HUMAN,
    prompt_number: 1,
    user_prompt: 'test prompt',
    started_at: now - 90,
    created_at: now - 90,
  }).id;
}

describe('release provenance API', () => {
  let tmpDir: string;
  let previousToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-provenance-api-'));
    const db = initDatabase(path.join(tmpDir, 'myco.db'));
    createSchema(db);
    previousToken = process.env.MYCO_TEST_GITHUB_TOKEN;
    delete process.env.MYCO_TEST_GITHUB_TOKEN;
  });

  afterEach(() => {
    closeDatabase();
    if (previousToken === undefined) delete process.env.MYCO_TEST_GITHUB_TOKEN;
    else process.env.MYCO_TEST_GITHUB_TOKEN = previousToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns annotation fields, parsed evidence, raw git rows, and readiness warnings', async () => {
    const now = 1_782_680_000;
    seedSession('sess-1', now);
    const batchId = seedBatch('sess-1', now);
    upsertReleaseState({
      project_id: PROJECT_ID,
      namespace: 'sessions',
      record_id: 'sess-1',
      source_session_id: 'sess-1',
      source_prompt_batch_id: batchId,
      state: 'released',
      confidence: 'high',
      basis_kind: 'git_ancestry',
      basis_ref: 'refs/tags/myco/v1.2.5',
      basis_sha: 'abc123',
      release_pr_number: 123,
      reason: 'Captured HEAD is contained in production ref refs/tags/myco/v1.2.5',
      evidence_json: JSON.stringify({ matched_ref: 'refs/tags/myco/v1.2.5', commits_ahead: 0 }),
      checked_at: now,
      created_at: now,
    });
    insertGitProvenance({
      project_id: PROJECT_ID,
      machine_id: 'machine-test',
      session_id: 'sess-1',
      prompt_batch_id: batchId,
      capture_point: 'session_end',
      captured_at: now - 10,
      branch: 'ck/daemon-ui-polish',
      head_sha: 'abc123',
      upstream_ref: 'refs/heads/main',
      production_ref: 'refs/tags/myco/v1.2.5',
      is_dirty: false,
      staged_count: 1,
      unstaged_count: 2,
      untracked_count: 3,
      changed_paths_json: JSON.stringify(['packages/myco/ui/src/components/release-state/ReleaseStateBadge.tsx']),
      patch_ids_json: JSON.stringify([{ kind: 'commit', patch_id: 'patch-1' }]),
      status_hash: 'status-1',
      evidence_json: JSON.stringify({ note: 'local evidence' }),
      error: 'git describe failed',
      created_at: now - 10,
    });

    const handlers = createReleaseProvenanceHandlers({ liveConfig: { current: makeConfig() } });
    const res = await handlers.handleGetReleaseProvenanceDetail(
      makeRequest({ namespace: 'sessions', recordId: 'sess-1' }),
      makePrincipal(),
    );

    expect(res.status ?? 200).toBe(200);
    const body = res.body as {
      annotation: { state: string; basis_sha: string; release_pr_number: number };
      evidence: { value: Record<string, unknown>; parse_warning: string | null };
      git_provenance: Array<{
        branch: string | null;
        changed_paths: string[];
        patch_ids: unknown[];
        error: string | null;
      }>;
      readiness: { github: { repo_configured: boolean; token_available: boolean }; warnings: string[] };
    };
    expect(body.annotation).toMatchObject({
      state: 'released',
      basis_sha: 'abc123',
      release_pr_number: 123,
    });
    expect(body.evidence.value).toMatchObject({ matched_ref: 'refs/tags/myco/v1.2.5' });
    expect(body.evidence.parse_warning).toBeNull();
    expect(body.git_provenance[0]).toMatchObject({
      branch: 'ck/daemon-ui-polish',
      changed_paths: ['packages/myco/ui/src/components/release-state/ReleaseStateBadge.tsx'],
      patch_ids: [{ kind: 'commit', patch_id: 'patch-1' }],
      error: 'git describe failed',
    });
    expect(body.readiness.github).toEqual({
      repo_configured: true,
      token_available: false,
    });
    expect(body.readiness.warnings).toContain('repo_configured_but_token_missing');
    expect(JSON.stringify(body)).not.toContain('MYCO_TEST_GITHUB_TOKEN=');
  });

  it('surfaces malformed evidence as a parse warning instead of a 500', async () => {
    const now = 1_782_680_000;
    seedSession('sess-bad-evidence', now);
    upsertReleaseState({
      project_id: PROJECT_ID,
      namespace: 'sessions',
      record_id: 'sess-bad-evidence',
      source_session_id: 'sess-bad-evidence',
      state: 'unknown',
      confidence: 'low',
      basis_kind: 'configuration',
      reason: 'Malformed evidence should not break the details UI',
      evidence_json: '{not-json',
      checked_at: now,
      created_at: now,
    });

    const handlers = createReleaseProvenanceHandlers({ liveConfig: { current: makeConfig() } });
    const res = await handlers.handleGetReleaseProvenanceDetail(
      makeRequest({ namespace: 'sessions', recordId: 'sess-bad-evidence' }),
      makePrincipal(),
    );

    expect(res.status ?? 200).toBe(200);
    const body = res.body as { evidence: { value: unknown; parse_warning: string | null } };
    expect(body.evidence.value).toBeNull();
    expect(body.evidence.parse_warning).toContain('Failed to parse evidence_json');
  });

  it('returns canonical error envelopes for invalid namespaces and missing rows', async () => {
    const handlers = createReleaseProvenanceHandlers({ liveConfig: { current: makeConfig() } });

    const invalid = await handlers.handleGetReleaseProvenanceDetail(
      makeRequest({ namespace: 'bad_namespace', recordId: 'sess-1' }),
      makePrincipal(),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: {
        code: 'invalid_release_namespace',
        message: 'Unknown release provenance namespace: bad_namespace',
      },
    });

    const missing = await handlers.handleGetReleaseProvenanceDetail(
      makeRequest({ namespace: 'sessions', recordId: 'missing' }),
      makePrincipal(),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: {
        code: 'release_provenance_not_found',
        message: 'No release provenance row found for sessions/missing',
      },
    });
  });
});

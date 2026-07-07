/**
 * Tests for the Team Host inbound tenancy pre-parse (`resolveInboundProjectId`).
 *
 * The pre-parse yields the effective project id WITHOUT any Grove/DB resolution,
 * and runs the local bearer gate exactly as the full resolver does. These tests
 * pin: header-first resolution, the project-root manifest fallback, the
 * no-tenancy fast path, malformed-id tolerance, and the auth gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectId } from './ids.js';
import { REQUEST_CONTEXT_AUTH_HEADER, REQUEST_CONTEXT_HEADERS, resolveInboundProjectId, UnauthorizedRequestContextError } from './request-context.js';
import { clearProjectManifestCache } from '../config/project-manifest.js';

const NO_AUTH = { expectedAuthToken: null };

describe('resolveInboundProjectId', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-inbound-'));
    clearProjectManifestCache();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns the x-myco-project-id header verbatim (the common case, no disk I/O)', () => {
    const projectId = createProjectId();
    const { projectId: resolved } = resolveInboundProjectId(
      { [REQUEST_CONTEXT_HEADERS.projectId]: projectId },
      tmp,
      NO_AUTH,
    );
    expect(resolved as string | null).toBe(projectId);
  });

  test('a malformed project-id header resolves to null (cannot be an attach key)', () => {
    const { projectId } = resolveInboundProjectId(
      { [REQUEST_CONTEXT_HEADERS.projectId]: 'not-a-valid-id' },
      tmp,
      NO_AUTH,
    );
    expect(projectId).toBeNull();
  });

  test('no project/root header → null without reading any manifest (anchor / no-tenancy path)', () => {
    const { projectId } = resolveInboundProjectId({}, tmp, NO_AUTH);
    expect(projectId).toBeNull();
  });

  test('falls back to project.toml at x-myco-project-root when no id header is present', () => {
    const projectRoot = path.join(tmp, 'checkout');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const projectId = createProjectId();
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), `[project]\nid = "${projectId}"\n`, 'utf-8');

    const { projectId: resolved } = resolveInboundProjectId(
      { [REQUEST_CONTEXT_HEADERS.projectRoot]: projectRoot },
      tmp,
      NO_AUTH,
    );
    expect(resolved as string | null).toBe(projectId);
  });

  test('the bearer gate rejects a switching header without the daemon token', () => {
    const projectId = createProjectId();
    expect(() =>
      resolveInboundProjectId(
        { [REQUEST_CONTEXT_HEADERS.projectId]: projectId },
        tmp,
        { expectedAuthToken: 'the-daemon-token' },
      ),
    ).toThrow(UnauthorizedRequestContextError);
  });

  test('the bearer gate passes when the switching header carries the matching token', () => {
    const projectId = createProjectId();
    const { projectId: resolved } = resolveInboundProjectId(
      {
        [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
        [REQUEST_CONTEXT_AUTH_HEADER]: 'the-daemon-token',
      },
      tmp,
      { expectedAuthToken: 'the-daemon-token' },
    );
    expect(resolved as string | null).toBe(projectId);
  });
});

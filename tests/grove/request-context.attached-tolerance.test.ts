/**
 * Team Host member local-dispatch tolerance for an ATTACHED project
 * (`resolveRegisteredRequestContext` attach branch, E-4 local-view requirement).
 *
 * Once an attached project is the member's ACTIVE UI selection, every
 * tenancy-headed request carries (localGroveId, attachedProjectId). A
 * `localhost-only` route classifies `local` and falls into the member daemon's
 * header resolution — where `findRegisteredProject` misses (an attached project
 * has no local Grove row) and, before this fix, threw `UnknownRequestContextError`
 * → 404 `unknown_tenancy`. These tests pin the bounded tolerance the daemon's
 * `resolveRouteRequestContext` opts into: an attached miss against an existing
 * LOCAL Grove resolves a display-only, grove-scoped, `attachedProject`-flagged
 * context (so the route reaches its handler = 200), while every non-attached
 * miss keeps the exact current refusal, and the tolerance stays opt-in.
 *
 * The resolver is what 404s; the transport merely maps the thrown error class to
 * 404 (see tests/tools/call-context-ownership.test.ts). So proving the resolver
 * no longer throws — and yields a DB-consistent context — is the 200-path proof.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  isAttachedProjectRequest,
  projectScopeFromRequestContext,
  requestContextFromHttpHeaders,
  UnknownRequestContextError,
} from '@myco/grove/request-context.js';
import { createGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath, resolveGroveDir } from '@myco/grove/paths.js';
import { createGroveId, createProjectId } from '@myco/grove/ids.js';
import { type HostRecord } from '@myco/host/registry.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';

/** A local display Grove owned by this daemon, plus an attached project (host
 *  ref only, NO local Grove row — the never-materialize shape). */
function seedAttachedProject(mycoHome: string): { localGroveId: string; attachedId: string } {
  const localGrove = createGrove('My Local Work', mycoHome);
  const attachedId = createProjectId();
  const record: HostRecord = {
    host_id: createGroveId().replace('grove_', 'host_'),
    label: 'Mac Studio',
    host_url: 'https://host-b.tailnet.ts.net:8443',
    protocol_version: HOST_PROTOCOL_VERSION,
    created_at: new Date().toISOString(),
    projects: [
      {
        grove_id: createGroveId(), // the HOSTED grove (host-owned, never resolved locally)
        project_id: attachedId,
        root: '/tmp/does-not-need-to-exist',
        local_grove_id: localGrove.id,
      },
    ],
  };
  writeHostRecordFixture(record);
  return { localGroveId: localGrove.id, attachedId };
}

const TOLERATE = {
  enforceGroveOwnership: true,
  tolerateAttachedProject: true,
  lockNamespace: testPerUserLockNamespace,
} as const;

describe('attached-project local-dispatch tolerance', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let vaultDir: string;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-attach-tolerance-');
    // The daemon anchor / fallback vault — a bare dir with no manifest, so the
    // base context is the daemon-global (project-less) one before headers apply.
    vaultDir = `${sandbox.mycoHome}/anchor/.myco`;
  });

  afterEach(() => sandbox.restore());

  test('attached id + existing LOCAL grove header resolves a display-only, grove-scoped context (no throw)', () => {
    const { localGroveId, attachedId } = seedAttachedProject(sandbox.mycoHome);

    const context = requestContextFromHttpHeaders(
      { 'x-myco-grove-id': localGroveId, 'x-myco-project-id': attachedId },
      vaultDir,
      TOLERATE,
    );

    // Carries the header's LOCAL grove + the attached project id, flagged.
    expect(context.groveId).toBe(localGroveId);
    expect(context.projectId).toBe(attachedId);
    expect(isAttachedProjectRequest(context)).toBe(true);
    expect(context.tenancySource).toBe('caller');

    // DB layer is the local display Grove's own DB — NOT a project vault (an
    // attached project has none), so nothing binds or creates one.
    expect(context.databasePath).toBe(resolveGroveDbPath(localGroveId, sandbox.mycoHome));
    expect(context.projectVaultDir).toBe(resolveGroveDir(localGroveId, sandbox.mycoHome));

    // A project-scoped read against this context scopes to the attached id and
    // finds zero local rows (correct: the project's data lives on the host).
    expect(projectScopeFromRequestContext(context)).toMatchObject({ kind: 'project', id: attachedId });
  });

  test('a genuinely unknown project id (not attached) keeps the current 404-class refusal', () => {
    const localGrove = createGrove('My Local Work', sandbox.mycoHome);
    const unknownId = createProjectId(); // no host ref, no local row

    expect(() =>
      requestContextFromHttpHeaders(
        { 'x-myco-grove-id': localGrove.id, 'x-myco-project-id': unknownId },
        vaultDir,
        TOLERATE,
      ),
    ).toThrow(UnknownRequestContextError);
  });

  test('attached id but a NONEXISTENT header grove keeps the current 404-class refusal', () => {
    const { attachedId } = seedAttachedProject(sandbox.mycoHome);

    expect(() =>
      requestContextFromHttpHeaders(
        { 'x-myco-grove-id': createGroveId(), 'x-myco-project-id': attachedId },
        vaultDir,
        TOLERATE,
      ),
    ).toThrow(UnknownRequestContextError);
  });

  test('tolerance is OPT-IN: an attached miss still throws when the flag is off (URL tenancy / mcp / external listener path)', () => {
    const { localGroveId, attachedId } = seedAttachedProject(sandbox.mycoHome);

    expect(() =>
      requestContextFromHttpHeaders(
        { 'x-myco-grove-id': localGroveId, 'x-myco-project-id': attachedId },
        vaultDir,
        { enforceGroveOwnership: true }, // tolerateAttachedProject omitted
      ),
    ).toThrow(UnknownRequestContextError);
  });

  test('resolution dials no host (pure disk read of the attach registry)', () => {
    const { localGroveId, attachedId } = seedAttachedProject(sandbox.mycoHome);
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      const context = requestContextFromHttpHeaders(
        { 'x-myco-grove-id': localGroveId, 'x-myco-project-id': attachedId },
        vaultDir,
        TOLERATE,
      );
      expect(isAttachedProjectRequest(context)).toBe(true);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

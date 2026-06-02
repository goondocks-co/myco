/**
 * Tests for the request-principal resolver — the single seam that turns a
 * request into an authorized tenant principal.
 *
 * The load-bearing invariant: the global daemon synthesizes a fallback
 * (bootstrap-anchor) request context for EVERY request before handlers run
 * (server.ts:347), so "is requestContext present?" is always true and is NOT
 * authorization. `resolvePrincipal` must reject tenancy that was synthesized
 * from the fallback (`tenancySource !== 'caller'`) and fail loud, accepting
 * only caller-supplied tenancy that survived the context-switch auth gate.
 */

import { describe, it, expect } from 'bun:test';
import {
  authorize,
  daemonHome,
  resolvePrincipal,
  TenancyViolationError,
} from '@myco/daemon/request-principal.js';

const CALLER_CONTEXT = {
  projectVaultDir: '/tenants/acme/.myco',
  projectId: 'proj_00000000000000000000000000000001',
  groveId: 'grove_00000000000000000000000000000002',
  tenancySource: 'caller' as const,
};

const ENV = { machineId: 'machine-xyz', userId: 'user-123' };

describe('resolvePrincipal', () => {
  it('returns a principal for a caller-supplied context', () => {
    const principal = resolvePrincipal({ requestContext: CALLER_CONTEXT }, ENV);

    expect(principal.tenancy.projectId).toBe(CALLER_CONTEXT.projectId);
    expect(principal.tenancy.groveId).toBe(CALLER_CONTEXT.groveId);
    expect(principal.tenancy.projectVaultDir).toBe(CALLER_CONTEXT.projectVaultDir);
  });

  it('exposes tenancy via flat fields only (no duplicated nested requestContext, #10a)', () => {
    const principal = resolvePrincipal({ requestContext: CALLER_CONTEXT }, ENV);

    expect(principal.tenancy.projectVaultDir).toBe(CALLER_CONTEXT.projectVaultDir);
    expect(principal.tenancy.projectId).toBe(CALLER_CONTEXT.projectId);
    expect(principal.tenancy.groveId).toBe(CALLER_CONTEXT.groveId);
    // The nested requestContext field was removed: it duplicated the flat
    // siblings and was read by no handler.
    expect('requestContext' in principal.tenancy).toBe(false);
  });

  it('carries identity from env (machineId + userId)', () => {
    const principal = resolvePrincipal({ requestContext: CALLER_CONTEXT }, ENV);

    expect(principal.identity.machineId).toBe('machine-xyz');
    expect(principal.identity.userId).toBe('user-123');
  });

  it('defaults a missing userId to null', () => {
    const principal = resolvePrincipal(
      { requestContext: CALLER_CONTEXT },
      { machineId: 'machine-xyz' },
    );

    expect(principal.identity.userId).toBeNull();
  });

  it('rejects a synthesized context even when all ids are present (presence is not authorization)', () => {
    const synthesized = { ...CALLER_CONTEXT, tenancySource: 'synthesized' as const };

    expect(() => resolvePrincipal({ requestContext: synthesized }, ENV)).toThrow(
      TenancyViolationError,
    );
    expect(() => resolvePrincipal({ requestContext: synthesized }, ENV)).toThrow(
      /synthesized/,
    );
  });

  it('rejects a context with no tenancySource marker', () => {
    const unmarked = {
      projectVaultDir: CALLER_CONTEXT.projectVaultDir,
      projectId: CALLER_CONTEXT.projectId,
      groveId: CALLER_CONTEXT.groveId,
    };

    expect(() => resolvePrincipal({ requestContext: unmarked }, ENV)).toThrow(
      TenancyViolationError,
    );
  });

  it('throws when requestContext is absent entirely', () => {
    expect(() => resolvePrincipal({}, ENV)).toThrow(TenancyViolationError);
    expect(() => resolvePrincipal({}, ENV)).toThrow(/missing project\/grove/);
  });

  it('throws when projectId is missing', () => {
    const ctx = { ...CALLER_CONTEXT, projectId: undefined };
    expect(() => resolvePrincipal({ requestContext: ctx }, ENV)).toThrow(
      TenancyViolationError,
    );
  });

  it('throws when groveId is missing', () => {
    const ctx = { ...CALLER_CONTEXT, groveId: undefined };
    expect(() => resolvePrincipal({ requestContext: ctx }, ENV)).toThrow(
      TenancyViolationError,
    );
  });

  it('throws when projectVaultDir is missing', () => {
    const ctx = { ...CALLER_CONTEXT, projectVaultDir: undefined };
    expect(() => resolvePrincipal({ requestContext: ctx }, ENV)).toThrow(
      TenancyViolationError,
    );
  });
});

describe('TenancyViolationError', () => {
  it('exposes the detail and a prefixed message', () => {
    const error = new TenancyViolationError('something went wrong');
    expect(error).toBeInstanceOf(Error);
    expect(error.detail).toBe('something went wrong');
    expect(error.message).toBe('Tenancy violation: something went wrong');
  });
});

describe('authorize', () => {
  it('does not throw for a valid local principal (allow-all)', () => {
    const principal = resolvePrincipal({ requestContext: CALLER_CONTEXT }, ENV);
    expect(() => authorize(principal)).not.toThrow();
  });
});

describe('daemonHome', () => {
  it('returns the path unchanged (sole DaemonHome constructor)', () => {
    expect(daemonHome('/var/lib/myco')).toBe('/var/lib/myco');
  });
});

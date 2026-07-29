import { describe, expect, it } from 'bun:test';
import {
  buildAuthRequiredNotification,
  isAuthRequiredFailure,
} from '@myco/notifications/auth-required.js';

describe('isAuthRequiredFailure', () => {
  it('matches only failed runs classified as auth', () => {
    expect(isAuthRequiredFailure({ status: 'failed', errorKind: 'auth' })).toBe(true);
    expect(isAuthRequiredFailure({ status: 'failed', errorKind: 'connection' })).toBe(false);
    expect(isAuthRequiredFailure({ status: 'failed' })).toBe(false);
    expect(isAuthRequiredFailure({ status: 'completed', errorKind: 'auth' })).toBe(false);
  });
});

describe('buildAuthRequiredNotification', () => {
  it('deep-links to the Settings agent card and names the remediation', () => {
    const payload = buildAuthRequiredNotification('title-summary', 'run-1');
    expect(payload.type).toBe('agent.auth.required');
    expect(payload.domain).toBe('agents');
    // The focus rule for agent.provider must resolve — a null target would
    // silently fall back to bare /settings and lose the scroll/highlight.
    expect(payload.link).toContain('/settings?');
    expect(payload.link).toContain('configSection=');
    expect(payload.link).toContain('configField=agent.provider');
    expect(payload.message).toContain('claude setup-token');
    expect(payload.metadata).toEqual({ taskName: 'title-summary', runId: 'run-1' });
  });
});

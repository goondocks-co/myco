/**
 * The scheduled-dispatch gate's key evidence for the anthropic provider.
 *
 * `missingKeyReason` decides whether a scheduled run dispatches at all: a
 * `missing_key` verdict silently skips dispatch. The Claude subscription
 * token must count as key evidence — otherwise an explicitly-configured
 * anthropic provider under token-only auth shows doctor green and a
 * connected Settings row while every scheduled task silently skips.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { KEYED_CLOUD_PROVIDER_ENV, missingKeyReason } from '@myco/agent/harness/provider-health.js';
import { CLAUDE_CODE_OAUTH_TOKEN_ENV } from '@myco/providers/env.js';
import { vi } from '../../helpers/vi-shim.js';

describe('missingKeyReason — anthropic token evidence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a subscription token as key evidence for anthropic', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv(CLAUDE_CODE_OAUTH_TOKEN_ENV, 'sk-ant-oat01-test');
    expect(missingKeyReason({ type: 'anthropic' })).toBeUndefined();
  });

  it('still reports missing_key when neither credential is present', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv(CLAUDE_CODE_OAUTH_TOKEN_ENV, '');
    expect(missingKeyReason({ type: 'anthropic' })).toBe('missing_key');
  });

  it('keeps ANTHROPIC_API_KEY as entry [0] — team-host compose reads the first entry as the team-key env name', () => {
    expect(KEYED_CLOUD_PROVIDER_ENV.anthropic?.[0]).toBe('ANTHROPIC_API_KEY');
    expect(KEYED_CLOUD_PROVIDER_ENV.anthropic).toContain(CLAUDE_CODE_OAUTH_TOKEN_ENV);
  });
});

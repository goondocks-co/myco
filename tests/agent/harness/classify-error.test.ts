// tests/agent/harness/classify-error.test.ts
import { describe, expect, test } from 'bun:test';
import {
  isConnectionError,
  isCapHitMessage,
  isAuthErrorMessage,
  buildHarnessAuthGuidance,
} from '@myco/agent/harness/classify-error.js';

describe('isConnectionError', () => {
  test.each([
    'Was there a typo in the url or port?',      // Bun fetch ECONNREFUSED hint
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:1234',
    'request to http://10.0.0.1:1234 failed, reason: ETIMEDOUT',
    'Unable to connect. Is the computer able to access the url?',
    'socket hang up',
    'ECONNRESET',
    // The synthesized 502 message openai.ts's harnessFetch produces when
    // OpenRouter's /api/v1/responses returns HTTP 200 for an upstream
    // provider failure (spore discovery-5c27c512) — must classify as
    // retryable connection-class, not a caller-content mistake.
    '502 OpenRouter upstream provider failure: Azure upstream rejected the request (response id: gen-abc123)',
    'provider_unavailable',
  ])('classifies "%s" as a connection error', (msg) => {
    expect(isConnectionError(msg)).toBe(true);
  });

  test.each([
    'Maximum number of turns exceeded',
    'The model did not call the required tool',
    'sink_response_unparseable',
  ])('does not classify content failure "%s" as connection', (msg) => {
    expect(isConnectionError(msg)).toBe(false);
  });
});

describe('isCapHitMessage', () => {
  test('matches max-turns wording', () => {
    expect(isCapHitMessage('Max turns (5) exceeded')).toBe(true);
    expect(isCapHitMessage('Was there a typo in the url or port?')).toBe(false);
  });
});

describe('isAuthErrorMessage', () => {
  test.each([
    // The CLI's no-credentials wording, exactly as the SDK relays it.
    'Claude Code returned an error result: Not logged in · Please run /login',
    // Expired/revoked headless token (observed CLI 2.1.220 wording).
    'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    'OAuth token expired',
    'Invalid API key · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
  ])('classifies "%s" as an auth error', (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(true);
  });

  test.each([
    'Was there a typo in the url or port?',
    'Reached maximum number of turns (5)',
    'sink_response_unparseable',
    'connect ECONNREFUSED 127.0.0.1:1234',
  ])('does not classify "%s" as auth', (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(false);
  });
});

describe('buildHarnessAuthGuidance', () => {
  test('keeps the original error and names the headless remediation', () => {
    const guidance = buildHarnessAuthGuidance('Not logged in · Please run /login', '/home/u/.myco/secrets.env');
    expect(guidance).toContain('Not logged in · Please run /login');
    expect(guidance).toContain('claude setup-token');
    expect(guidance).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(guidance).toContain('/home/u/.myco/secrets.env');
  });
});

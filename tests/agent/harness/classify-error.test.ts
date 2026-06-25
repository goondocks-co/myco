// tests/agent/harness/classify-error.test.ts
import { describe, expect, test } from 'bun:test';
import { isConnectionError, isCapHitMessage } from '@myco/agent/harness/classify-error.js';

describe('isConnectionError', () => {
  test.each([
    'Was there a typo in the url or port?',      // Bun fetch ECONNREFUSED hint
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:1234',
    'request to http://10.0.0.1:1234 failed, reason: ETIMEDOUT',
    'Unable to connect. Is the computer able to access the url?',
    'socket hang up',
    'ECONNRESET',
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

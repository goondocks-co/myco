import { describe, expect, it } from 'bun:test';
import { isRunnerUpdateText, RUNNER_UPDATE_REASON_MAX, sanitizeRunnerUpdateReason } from '@goondocks/myco-shared/runner-update';

describe('runner update text contract', () => {
  it('replaces Unicode controls, format characters and line separators with displayable spaces', () => {
    expect(sanitizeRunnerUpdateReason('probe\u0085failed\u200bto\u2028launch\u2029again')).toBe('probe failed to launch again');
    for (const text of ['a\u0085b', 'a\u200bb', 'a\u2028b', 'a\u2029b']) expect(isRunnerUpdateText(text, 512)).toBe(false);
    expect(sanitizeRunnerUpdateReason('\u0085\u200b\u2028')).toBe('Update failed');
  });
  it('bounds Unicode code points without splitting an emoji or rejecting the exact limit', () => {
    const atLimit = '😀'.repeat(RUNNER_UPDATE_REASON_MAX);
    expect(isRunnerUpdateText(atLimit, RUNNER_UPDATE_REASON_MAX)).toBe(true);
    expect(isRunnerUpdateText(atLimit + 'a', RUNNER_UPDATE_REASON_MAX)).toBe(false);
    expect(sanitizeRunnerUpdateReason(atLimit + 'a')).toBe(atLimit);
    expect(isRunnerUpdateText('', RUNNER_UPDATE_REASON_MAX)).toBe(false);
    expect(isRunnerUpdateText(null, RUNNER_UPDATE_REASON_MAX)).toBe(false);
  });
});

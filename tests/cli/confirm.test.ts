import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { confirmDestructive } from '@myco/cli/confirm.js';

describe('confirmDestructive', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    vi.restoreAllMocks();
  });

  it('refuses without prompting when stdin is not a TTY, printing the summary and a --yes hint', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await confirmDestructive('This will delete EVERYTHING.');

    expect(result).toBe(false);
    const output = stderrSpy.mock.calls.flat().join('');
    expect(output).toContain('This will delete EVERYTHING.');
    expect(output).toContain('--yes');
  });
});

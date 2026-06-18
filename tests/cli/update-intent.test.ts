import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/update.js';

/**
 * `myco update --target-version` / `--cancel-update` were removed in the
 * Task 9 refactor (binary upgrades moved to `myco upgrade [<version>]`).
 *
 * These tests verify that the old flags produce a clear redirect error
 * instead of silently doing nothing or partially executing.
 */
describe('myco update --target-version / --cancel-update redirect', () => {
  it('--target-version exits non-zero with a redirect message', async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(run(['--target-version', '1.2.3'])).rejects.toThrow('__exit__');

    expect(errors.some((e) => e.includes('myco upgrade'))).toBe(true);
    expect(errors.some((e) => e.includes('binary upgrades') || e.includes('Binary upgrades'))).toBe(true);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('--cancel-update exits non-zero with a redirect message', async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);

    await expect(run(['--cancel-update'])).rejects.toThrow('__exit__');

    expect(errors.some((e) => e.includes('myco upgrade'))).toBe(true);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

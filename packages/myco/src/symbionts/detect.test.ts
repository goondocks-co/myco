/**
 * Tests for symbiont PATH detection.
 *
 * `myco doctor` reports whether each agent's binary is on PATH. The lookup
 * shells out to `which` on POSIX, but `which` does not exist on Windows — it
 * ships `where`. `pathLookupProgram` selects the right program per platform;
 * both share the same exit-code contract (0 = found).
 */

import { describe, test, expect } from 'bun:test';
import { pathLookupProgram } from './detect.js';

describe('pathLookupProgram', () => {
  test('uses `where` on Windows', () => {
    expect(pathLookupProgram('win32')).toBe('where');
  });

  test('uses `which` on POSIX platforms', () => {
    expect(pathLookupProgram('darwin')).toBe('which');
    expect(pathLookupProgram('linux')).toBe('which');
  });

  test('defaults to the current platform when no argument is given', () => {
    const expected = process.platform === 'win32' ? 'where' : 'which';
    expect(pathLookupProgram()).toBe(expected);
  });
});

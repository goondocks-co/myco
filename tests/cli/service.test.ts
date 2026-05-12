import { describe, expect, test } from 'bun:test';
import { parseServiceArgs } from '../../packages/myco/src/cli/service';

describe('parseServiceArgs', () => {
  test('install (no flags) → variant=prod', () => {
    expect(parseServiceArgs(['install'])).toEqual({ action: 'install', variant: 'prod' });
  });

  test('install --dev → variant=dev', () => {
    expect(parseServiceArgs(['install', '--dev'])).toEqual({ action: 'install', variant: 'dev' });
  });

  test('uninstall --dev', () => {
    expect(parseServiceArgs(['uninstall', '--dev'])).toEqual({ action: 'uninstall', variant: 'dev' });
  });

  test('status defaults to prod', () => {
    expect(parseServiceArgs(['status'])).toEqual({ action: 'status', variant: 'prod' });
  });

  test('rejects unknown action', () => {
    expect(() => parseServiceArgs(['frobnicate'])).toThrow(/unknown.*frobnicate/i);
  });

  test('rejects missing action', () => {
    expect(() => parseServiceArgs([])).toThrow(/usage/i);
  });
});

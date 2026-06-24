import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { parseServiceArgs, assertSafeServiceMutation } from '../../packages/myco/src/cli/service';

const DEFAULT_HOME = path.join(os.homedir(), '.myco');
const DOGFOOD_HOME = path.join(os.homedir(), '.myco-dev');

describe('parseServiceArgs', () => {
  test('install (no flags) → action=install', () => {
    expect(parseServiceArgs(['install'])).toEqual({ action: 'install' });
  });

  test('uninstall', () => {
    expect(parseServiceArgs(['uninstall'])).toEqual({ action: 'uninstall' });
  });

  test('status', () => {
    expect(parseServiceArgs(['status'])).toEqual({ action: 'status' });
  });

  test('restart', () => {
    expect(parseServiceArgs(['restart'])).toEqual({ action: 'restart' });
  });

  test('reconcile', () => {
    expect(parseServiceArgs(['reconcile'])).toEqual({ action: 'reconcile' });
  });

  test('rejects unknown action', () => {
    expect(() => parseServiceArgs(['frobnicate'])).toThrow(/unknown.*frobnicate/i);
  });

  test('rejects missing action', () => {
    expect(() => parseServiceArgs([])).toThrow(/usage/i);
  });
});

// Regression: a dev daemon was once allowed to manage the default-home
// (~/.myco) plist, which produced a multi-minute prod outage when the dev
// binary's plist format diverged from the installed prod binary's. The fence
// below makes that path unreachable at the CLI boundary — keyed on the home now
// (the default home is the production install), not a prod/dev variant.
describe('assertSafeServiceMutation (default-home-from-dev-binary fence)', () => {
  // New layout: dev binary lives in its own platform package, sibling
  // to packages/myco/. Legacy layout: binary lived under packages/myco/vendor/.
  // Both must be caught by the dev-build guard.
  const devBuildPath = '/Users/dev/repos/myco/packages/myco-darwin-arm64/bin/myco';
  const legacyDevBuildPath = '/Users/dev/repos/myco/packages/myco/vendor/darwin-arm64/myco';
  const globalPath = '/opt/homebrew/lib/node_modules/@goondocks/myco-darwin-arm64/bin/myco';

  test('refuses every mutating verb against the default home when run from a dev-build binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'reconcile'] as const) {
      const refusal = assertSafeServiceMutation({ action }, devBuildPath, DEFAULT_HOME);
      expect(refusal).not.toBeNull();
      expect(refusal!).toMatch(/Refusing to .* the default-home \(~\/\.myco\) service from a dev-build binary/);
    }
  });

  test('refuses every mutating verb against the default home from the legacy vendor/<arch>/ layout', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'reconcile'] as const) {
      const refusal = assertSafeServiceMutation({ action }, legacyDevBuildPath, DEFAULT_HOME);
      expect(refusal).not.toBeNull();
      expect(refusal!).toMatch(/Refusing to .* the default-home \(~\/\.myco\) service from a dev-build binary/);
    }
  });

  test('allows status against the default home even from a dev-build binary (read-only)', () => {
    expect(assertSafeServiceMutation({ action: 'status' }, devBuildPath, DEFAULT_HOME)).toBeNull();
  });

  test('allows all actions against a non-default (dogfood) home from a dev-build binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'reconcile'] as const) {
      expect(assertSafeServiceMutation({ action }, devBuildPath, DOGFOOD_HOME)).toBeNull();
    }
  });

  test('allows all actions against the default home from the globally installed binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'reconcile'] as const) {
      expect(assertSafeServiceMutation({ action }, globalPath, DEFAULT_HOME)).toBeNull();
    }
  });
});

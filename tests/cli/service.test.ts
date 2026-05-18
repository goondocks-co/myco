import { describe, expect, test } from 'bun:test';
import { parseServiceArgs, assertSafeServiceMutation } from '../../packages/myco/src/cli/service';

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

  test('restart (no flags) → variant=prod', () => {
    expect(parseServiceArgs(['restart'])).toEqual({ action: 'restart', variant: 'prod' });
  });

  test('restart --dev → variant=dev', () => {
    expect(parseServiceArgs(['restart', '--dev'])).toEqual({ action: 'restart', variant: 'dev' });
  });

  test('rejects unknown action', () => {
    expect(() => parseServiceArgs(['frobnicate'])).toThrow(/unknown.*frobnicate/i);
  });

  test('rejects missing action', () => {
    expect(() => parseServiceArgs([])).toThrow(/usage/i);
  });
});

// Regression: the dev daemon was once allowed to manage the prod plist,
// which produced a multi-minute prod outage when the dev binary's plist
// format diverged from the installed prod binary's. The fence below
// makes that path unreachable at the CLI boundary.
describe('assertSafeServiceMutation (prod-from-dev-binary fence)', () => {
  // New layout: dev binary lives in its own platform package, sibling
  // to packages/myco/. Legacy layout: binary lived under packages/myco/vendor/.
  // Both must be caught by the dev-build guard.
  const devBuildPath = '/Users/dev/repos/myco/packages/myco-darwin-arm64/bin/myco';
  const legacyDevBuildPath = '/Users/dev/repos/myco/packages/myco/vendor/darwin-arm64/myco';
  const globalPath = '/opt/homebrew/lib/node_modules/@goondocks/myco-darwin-arm64/bin/myco';

  test('refuses every mutating verb against prod when run from a dev-build binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart'] as const) {
      const refusal = assertSafeServiceMutation({ action, variant: 'prod' }, devBuildPath);
      expect(refusal).not.toBeNull();
      expect(refusal!).toMatch(/Refusing to .* the \*prod\* service from a dev-build binary/);
    }
  });

  test('refuses every mutating verb against prod from the legacy vendor/<arch>/ layout', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart'] as const) {
      const refusal = assertSafeServiceMutation({ action, variant: 'prod' }, legacyDevBuildPath);
      expect(refusal).not.toBeNull();
      expect(refusal!).toMatch(/Refusing to .* the \*prod\* service from a dev-build binary/);
    }
  });

  test('allows status against prod even from a dev-build binary (read-only)', () => {
    expect(assertSafeServiceMutation({ action: 'status', variant: 'prod' }, devBuildPath)).toBeNull();
  });

  test('allows all actions against dev variant from a dev-build binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as const) {
      expect(assertSafeServiceMutation({ action, variant: 'dev' }, devBuildPath)).toBeNull();
    }
  });

  test('allows all actions against prod variant from the globally installed binary', () => {
    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as const) {
      expect(assertSafeServiceMutation({ action, variant: 'prod' }, globalPath)).toBeNull();
    }
  });
});

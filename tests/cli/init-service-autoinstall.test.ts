import { describe, expect, test } from 'bun:test';
import { detectInstallVariant } from '../../packages/myco/src/cli/service';
import { setDevServiceMode } from '../../packages/myco/src/grove/paths';

describe('detectInstallVariant', () => {
  test('returns "prod" when devServiceMode is false', () => {
    setDevServiceMode(false);
    expect(detectInstallVariant()).toBe('prod');
  });

  test('returns "dev" when devServiceMode is true', () => {
    setDevServiceMode(true);
    try {
      expect(detectInstallVariant()).toBe('dev');
    } finally {
      setDevServiceMode(false);
    }
  });
});

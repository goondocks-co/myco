import { describe, expect, it } from 'vitest';
import {
  MYCO_PROJECT_ROOT_ENV,
  MYCO_VAULT_DIR_ENV,
  resolveVaultDir,
} from '@myco/vault/resolve.js';

describe('resolveVaultDir', () => {
  it('prefers explicit vault dir env over cwd discovery', () => {
    const result = resolveVaultDir('/', {
      [MYCO_VAULT_DIR_ENV]: '/tmp/custom-vault',
      [MYCO_PROJECT_ROOT_ENV]: '/tmp/project-root',
    });

    expect(result).toBe('/tmp/custom-vault');
  });

  it('derives vault dir from explicit project root env when present', () => {
    const result = resolveVaultDir('/', {
      [MYCO_PROJECT_ROOT_ENV]: '/tmp/project-root',
    });

    expect(result).toBe('/tmp/project-root/.myco');
  });

  it('ignores non-absolute env values and falls back to cwd resolution', () => {
    const result = resolveVaultDir('/tmp/project-root', {
      [MYCO_PROJECT_ROOT_ENV]: 'relative-root',
      [MYCO_VAULT_DIR_ENV]: '.myco',
    });

    expect(result).toBe('/tmp/project-root/.myco');
  });
});

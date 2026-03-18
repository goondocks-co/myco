import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { collapseHomePath } from '@myco/cli/shared';

describe('collapseHomePath', () => {
  const home = os.homedir();

  it('collapses absolute home path to ~/', () => {
    expect(collapseHomePath(path.join(home, '.myco', 'vaults', 'myco')))
      .toBe('~/.myco/vaults/myco');
  });

  it('collapses bare home directory', () => {
    expect(collapseHomePath(home)).toBe('~');
  });

  it('leaves non-home paths unchanged', () => {
    expect(collapseHomePath('/tmp/vault')).toBe('/tmp/vault');
  });

  it('leaves relative paths unchanged', () => {
    expect(collapseHomePath('.myco/vault')).toBe('.myco/vault');
  });

  it('does not collapse partial prefix match', () => {
    // e.g., /Users/chris2 should NOT match /Users/chris
    expect(collapseHomePath(home + '2/vault')).toBe(home + '2/vault');
  });
});

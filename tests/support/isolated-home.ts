/**
 * Per-test isolated `MYCO_HOME`.
 *
 * Multi-grove / tenancy tests need a *fresh* daemon home per test so they
 * don't see each other's grove config. This registers the `beforeEach`/
 * `afterEach` lifecycle that points `MYCO_HOME` at a new temp dir (invalidating
 * the merged-config cache around the swap), restores the previous value, and
 * deletes the dir afterward — so individual tests stop hand-rolling that dance.
 *
 * Note the safety floor is separate: `tests/setup/vitest.ts` already sandboxes
 * `MYCO_HOME` at the process level when unset, so no test can write the real
 * `~/.myco`. This helper is about *per-test* isolation + DRY, not that floor.
 *
 * Usage:
 * ```ts
 * describe('...', () => {
 *   const home = useIsolatedHome('myco-feature-home-');
 *   beforeEach(() => {
 *     saveMachineConfig({} as never);
 *     saveGroveConfig(GROVE_ID, { ... } as never);
 *   });
 *   it('...', () => { ...read home.path if you need the dir... });
 * });
 * ```
 * The helper's `beforeEach` runs before any you register afterward, so your
 * own `saveGroveConfig`/vault setup writes into the isolated home.
 */
import { afterEach, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidateMergedConfigCache } from '@myco/config/loader';

/** Handle to the current test's isolated `MYCO_HOME`. `path` is valid inside
 *  each test body and the test's own `beforeEach`/`afterEach`. */
export interface IsolatedHome {
  readonly path: string;
}

export function useIsolatedHome(prefix = 'myco-test-home-'): IsolatedHome {
  let dir = '';
  let previous: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    previous = process.env.MYCO_HOME;
    process.env.MYCO_HOME = dir;
    invalidateMergedConfigCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previous;
    invalidateMergedConfigCache();
  });

  return {
    get path() {
      return dir;
    },
  };
}

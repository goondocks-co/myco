/**
 * Drift gate: the UI is a separate workspace and cannot import the canonical
 * spore-status module, so SporeList's filter dropdown and helpers' badge map
 * mirror SPORE_STATUSES by hand. This test fails if a status is added to the
 * canonical set without being reflected in those UI sites — turning the
 * "keep in sync" comment into an enforced contract.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SPORE_STATUSES } from '@myco/constants/spore-status.js';

const UI_DIR = path.resolve(import.meta.dir, '../../packages/myco/ui/src/components/mycelium');
const sporeList = readFileSync(path.join(UI_DIR, 'SporeList.tsx'), 'utf8');
const helpers = readFileSync(path.join(UI_DIR, 'helpers.ts'), 'utf8');

describe('UI spore-status parity with the canonical set', () => {
  it('SporeList STATUS_OPTIONS lists every canonical status', () => {
    for (const status of SPORE_STATUSES) {
      expect(sporeList.includes(`'${status}'`)).toBe(true);
    }
  });

  it('helpers.statusClass has a badge tone for every canonical status', () => {
    for (const status of SPORE_STATUSES) {
      // 'active' (and any future status) must have an explicit case so badges
      // are styled deliberately rather than silently hitting the default.
      expect(helpers.includes(`case '${status}':`)).toBe(true);
    }
  });
});

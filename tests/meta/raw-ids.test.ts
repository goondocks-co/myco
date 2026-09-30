/**
 * The raw-id pattern the screen checks and the jsdom suites share catches
 * every id the dashboard could leak, minted the way the server mints it, and
 * leaves the words a page does show alone.
 */
import { describe, expect, it } from 'bun:test';
import { RAW_ID } from '../helpers/raw-ids.ts';
import { mintSporeId } from '../../packages/myco-server/src/core/spore-writes.ts';
import { OBSERVATION_TYPES } from '../../packages/myco/src/vault/types.ts';

describe('the raw-id pattern', () => {
  it('matches a spore id of every observation type, as the server mints it', () => {
    for (const type of OBSERVATION_TYPES) expect(`saved ${mintSporeId(type)} today`).toMatch(RAW_ID);
  });

  it('matches plan keys, session ids and the prefixed ids', () => {
    for (const id of [crypto.randomUUID(), 'run_4f1c9a2e7b', 'proj_6d79636f3a3e1c0b', 'mem_q3Vb8xRk2LmT7wYz', 'mt_0123456789abcdef']) {
      expect(`see ${id}`).toMatch(RAW_ID);
    }
  });

  it('leaves the words a page shows alone', () => {
    for (const text of ['main @ a1b2c3d4', 'Sep 29, 14:02', 'Cross-cutting', 'Trade-off saved Sep 29', '1 of 3 items done', 'docs/plans/work-outcomes.md', 'Bind port 0']) {
      expect(text).not.toMatch(RAW_ID);
    }
  });
});

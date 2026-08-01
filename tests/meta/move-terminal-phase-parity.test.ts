/**
 * `TERMINAL_PHASES` (grove/move.ts) and `MOVE_TERMINAL_PHASES`
 * (grove/lease-evidence.ts) are deliberately duplicated — lease-evidence
 * stays dependency-free of the operations it describes — but they encode ONE
 * fact. Divergence would make a phase the move considers finished read as
 * unfinished by the lease (a permanent hold) or vice versa (a freed lease
 * mid-move). This pins them equal, so a change to either set names the other.
 */
import { describe, expect, test } from 'bun:test';
import { TERMINAL_PHASES } from '@myco/grove/move.js';
import { MOVE_TERMINAL_PHASES } from '@myco/grove/lease-evidence.js';

describe('move terminal-phase parity', () => {
  test('the hand-copied sets are identical', () => {
    expect([...TERMINAL_PHASES].sort()).toEqual([...MOVE_TERMINAL_PHASES].sort());
  });
});

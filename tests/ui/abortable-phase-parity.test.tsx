/**
 * The UI's Cancel-control allowlist must equal the daemon's abort allowlist —
 * a drifted UI either offers a cancel the daemon refuses or hides one it
 * accepts. Both sides export the set; this pins them equal.
 */
import { describe, expect, it } from 'bun:test';
import { ABORTABLE_RESIDENCY_PHASES as UI_SET } from '../../packages/myco/ui/src/hooks/use-host-membership';
import { ABORTABLE_RESIDENCY_PHASES as DAEMON_SET } from '@myco/host/residency-journal.js';

describe('abortable-phase parity', () => {
  it('UI mirror equals the daemon allowlist', () => {
    expect([...UI_SET].sort()).toEqual([...DAEMON_SET].sort());
  });
});

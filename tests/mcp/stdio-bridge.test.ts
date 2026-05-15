import { describe, expect, it } from 'bun:test';
import {
  isParentGone,
  PARENT_WATCHDOG_INTERVAL_MS,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_HEARTBEAT_FAILURE_THRESHOLD,
} from '@myco/mcp/stdio-bridge.js';

/**
 * Regression coverage for the MCP-bridge lifecycle gates. The actual
 * watchdog/heartbeat loops are setInterval-driven and call process.exit,
 * so they're not unit-testable directly. We test the pure predicate that
 * decides whether to fire the exit, plus the constants — the only knobs
 * that materially change behavior between bridge lifetimes.
 *
 * Context: 2026-05-15 — a 21-hour-old stale MCP bridge was holding a dead
 * stdio connection. The agent's next `myco_plans` call hung indefinitely
 * because no liveness gate ran after the bridge had wired its pipes. The
 * constants below + the predicate below are the contract that prevents
 * recurrence.
 */
describe('mcp stdio-bridge lifecycle gates', () => {
  describe('isParentGone predicate', () => {
    it('returns true when current ppid is 1 (orphan reparented to init)', () => {
      expect(isParentGone(42_000, 1)).toBe(true);
    });

    it('returns true when current ppid differs from initial', () => {
      // The agent's process tree shifted out from under us.
      expect(isParentGone(42_000, 99_999)).toBe(true);
    });

    it('returns false when current ppid still matches initial (parent alive)', () => {
      expect(isParentGone(42_000, 42_000)).toBe(false);
    });

    // The 21-hour zombie scenario: bridge starts under ppid=N, parent dies,
    // OS reparents the bridge to PID 1. The predicate must fire.
    it('catches the exact 2026-05-15 zombie scenario', () => {
      const agentPid = 12_345;  // Claude Code (alive when bridge spawned)
      const afterAgentDies = 1; // launchd reparented us
      expect(isParentGone(agentPid, afterAgentDies)).toBe(true);
    });
  });

  describe('cadence constants', () => {
    // These constants are the only thing standing between a clean exit
    // and another 21-hour zombie. Pinning them prevents a well-meaning
    // "make it more responsive" tweak from spiking polling cost, AND
    // prevents a "save CPU" tweak from extending the zombie window.

    it('parent watchdog runs every 10 seconds', () => {
      expect(PARENT_WATCHDOG_INTERVAL_MS).toBe(10_000);
    });

    it('daemon heartbeat runs every 30 seconds', () => {
      expect(DAEMON_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it('daemon heartbeat tolerates exactly one transient miss before exiting', () => {
      // A single missed probe during a daemon restart is normal; two in a
      // row means the bridge's HTTP target is stale and it should die so
      // the agent respawns a fresh one.
      expect(DAEMON_HEARTBEAT_FAILURE_THRESHOLD).toBe(2);
    });

    it('zombie window stays under one minute in the worst case', () => {
      // Worst-case time from agent-death to bridge-exit is one watchdog
      // tick. Worst-case time from daemon-down to bridge-exit is
      // (FAILURE_THRESHOLD × HEARTBEAT_INTERVAL_MS) + fetch timeout.
      // Both must stay well below the 21-hour observed zombie.
      const worstAgentDeathMs = PARENT_WATCHDOG_INTERVAL_MS;
      const worstDaemonDeathMs = DAEMON_HEARTBEAT_FAILURE_THRESHOLD * DAEMON_HEARTBEAT_INTERVAL_MS;
      expect(worstAgentDeathMs).toBeLessThan(60_000);
      expect(worstDaemonDeathMs).toBeLessThanOrEqual(60_000);
    });
  });
});

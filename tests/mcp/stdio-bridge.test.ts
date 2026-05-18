import { describe, expect, it } from 'bun:test';
import {
  isParentGone,
  PARENT_WATCHDOG_INTERVAL_MS,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_HEARTBEAT_FAILURE_THRESHOLD,
  UPSTREAM_SEND_TIMEOUT_MS,
  SELF_HEAL_PROBE_ATTEMPTS,
  SELF_HEAL_PROBE_BACKOFFS_MS,
} from '@myco/mcp/stdio-bridge.js';

/**
 * Regression coverage for the MCP-bridge lifecycle gates. The actual
 * watchdog/heartbeat/self-heal loops are setInterval-driven and call
 * process.exit, so they're not unit-testable directly. We test the pure
 * predicate that decides whether to fire the exit, plus the constants —
 * the only knobs that materially change behavior between bridge lifetimes.
 *
 * Context: 2026-05-15 — a 21-hour-old stale MCP bridge was holding a dead
 * stdio connection. The agent's next `myco_plans` call hung indefinitely
 * because no liveness gate ran after the bridge had wired its pipes.
 * 2026-05-17 — a `make build` rebuild during a live dogfood session
 * surfaced a 60-second hang on the next MCP tool call: the bridge's
 * existing upstream connection pointed at a dead socket and the previous
 * heartbeat cadence (30 s × 2) was too loose. Bucket J tightens the
 * cadence to 5 s × 2 and adds an active-send self-heal path that probes
 * + rebuilds upstream on the next message.
 *
 * The constants below + the predicate below are the contract that
 * prevents recurrence.
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

  describe('background-heartbeat cadence constants', () => {
    // These constants are the only thing standing between a clean exit
    // and another 21-hour zombie. Pinning them prevents a well-meaning
    // "make it more responsive" tweak from spiking polling cost, AND
    // prevents a "save CPU" tweak from extending the zombie window.

    it('parent watchdog runs every 10 seconds', () => {
      expect(PARENT_WATCHDOG_INTERVAL_MS).toBe(10_000);
    });

    it('daemon heartbeat runs every 5 seconds (Bucket J: was 30 s — too loose for `make build` restarts)', () => {
      // The earlier 30 s × 2 cadence produced a worst-case 60-second hang
      // on the next MCP tool call after a daemon rebuild. 5 s × 2 caps
      // that at ~10 s for an idle bridge; the active-send self-heal
      // shrinks it further when a message is actually in flight.
      expect(DAEMON_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    });

    it('daemon heartbeat tolerates exactly one transient miss before exiting', () => {
      // A single missed probe during a daemon restart is normal; two in a
      // row means the bridge's HTTP target is stale and it should die so
      // the agent respawns a fresh one.
      expect(DAEMON_HEARTBEAT_FAILURE_THRESHOLD).toBe(2);
    });

    it('zombie window stays under 30 seconds in the worst case', () => {
      // Worst-case time from agent-death to bridge-exit is one watchdog
      // tick. Worst-case time from daemon-down to bridge-exit via the
      // background heartbeat alone is (FAILURE_THRESHOLD × HEARTBEAT_INTERVAL_MS)
      // plus the per-probe fetch timeout. The active-send self-heal beats
      // this when a message is in flight; this assertion locks in the
      // bound on the IDLE-bridge case.
      const worstAgentDeathMs = PARENT_WATCHDOG_INTERVAL_MS;
      const worstDaemonDeathMs = DAEMON_HEARTBEAT_FAILURE_THRESHOLD * DAEMON_HEARTBEAT_INTERVAL_MS;
      expect(worstAgentDeathMs).toBeLessThan(30_000);
      expect(worstDaemonDeathMs).toBeLessThanOrEqual(30_000);
    });
  });

  describe('active-send self-heal constants (Bucket J)', () => {
    it('caps a single forwarded JSON-RPC message at UPSTREAM_SEND_TIMEOUT_MS', () => {
      // Long enough that legitimate slow tool calls (skill-generate,
      // skill-evolve, long agent runs that stream progress) don't false-
      // trip the self-heal path; short enough that a hung half-open
      // socket from a dead daemon doesn't sit waiting for OS TCP
      // keepalive (often minutes by default).
      expect(UPSTREAM_SEND_TIMEOUT_MS).toBe(120_000);
    });

    it('probes the daemon up to SELF_HEAL_PROBE_ATTEMPTS times before giving up', () => {
      // A `make build` rebuild typically completes in a few seconds; the
      // probe budget covers normal rebuild times without giving up so
      // eagerly that a slow machine forces a full bridge respawn.
      expect(SELF_HEAL_PROBE_ATTEMPTS).toBe(5);
    });

    it('exposes per-attempt backoffs whose total stays under the heartbeat exit window', () => {
      // If the self-heal probe budget took longer than the background
      // heartbeat's exit threshold, the bridge could die out from under
      // a self-heal in progress. Belt-and-suspenders: keep the probe
      // total comfortably below the heartbeat-driven exit time.
      expect(SELF_HEAL_PROBE_BACKOFFS_MS).toHaveLength(SELF_HEAL_PROBE_ATTEMPTS);
      const totalBackoffMs = SELF_HEAL_PROBE_BACKOFFS_MS.reduce((sum, ms) => sum + ms, 0);
      const heartbeatExitWindowMs = DAEMON_HEARTBEAT_FAILURE_THRESHOLD * DAEMON_HEARTBEAT_INTERVAL_MS;
      expect(totalBackoffMs).toBeLessThan(heartbeatExitWindowMs);
    });

    it('backoffs grow monotonically so retries spread under sustained restarts', () => {
      for (let i = 1; i < SELF_HEAL_PROBE_BACKOFFS_MS.length; i++) {
        expect(SELF_HEAL_PROBE_BACKOFFS_MS[i]!).toBeGreaterThanOrEqual(
          SELF_HEAL_PROBE_BACKOFFS_MS[i - 1]!,
        );
      }
    });
  });
});

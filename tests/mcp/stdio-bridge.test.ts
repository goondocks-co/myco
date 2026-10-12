import { describe, expect, it } from 'bun:test';
import { isParentGone, PARENT_WATCHDOG_INTERVAL_MS, UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD,
  UPSTREAM_SEND_TIMEOUT_MS, SELF_HEAL_PROBE_BACKOFFS_MS, REQUEST_RESEND_MAX_ATTEMPTS } from '@myco/mcp/stdio-bridge.js';
describe('mcp stdio-bridge lifecycle gates', () => {
  describe('isParentGone predicate', () => {
    it('returns true when current ppid is 1 (orphan reparented to init)', () => {
      expect(isParentGone(42_000, 1)).toBe(true);
    });

    it('returns true when current ppid differs from initial', () => {

      expect(isParentGone(42_000, 99_999)).toBe(true);
    });

    it('returns false when current ppid still matches initial (parent alive)', () => {
      expect(isParentGone(42_000, 42_000)).toBe(false);
    });


    it('catches the exact 2026-05-15 zombie scenario', () => {
      const agentPid = 12_345;  // Claude Code (alive when bridge spawned)
      const afterAgentDies = 1; // launchd reparented us
      expect(isParentGone(agentPid, afterAgentDies)).toBe(true);
    });
  });

  describe('background-heartbeat cadence constants', () => {





    it('parent watchdog runs every 10 seconds', () => {
      expect(PARENT_WATCHDOG_INTERVAL_MS).toBe(10_000);
    });

    it('agent-death detection stays under 30 seconds', () => {





      expect(PARENT_WATCHDOG_INTERVAL_MS).toBeLessThan(30_000);
    });

    it('heartbeat threshold triggers self-heal, not bridge exit', () => {






      expect(UPSTREAM_HEARTBEAT_FAILURE_THRESHOLD).toBe(2);
    });
  });

  describe('active-send self-heal constants (Deployment)', () => {
    it('caps a single forwarded JSON-RPC message at UPSTREAM_SEND_TIMEOUT_MS', () => {







      expect(UPSTREAM_SEND_TIMEOUT_MS).toBe(30_000);
    });

    it('caps the per-message re-send loop at REQUEST_RESEND_MAX_ATTEMPTS', () => {





      expect(REQUEST_RESEND_MAX_ATTEMPTS).toBe(2);
    });

    it('exposes an indefinite probe backoff schedule (the bridge never gives up on Deployment outage)', () => {





      expect(SELF_HEAL_PROBE_BACKOFFS_MS.length).toBeGreaterThan(0);
    });

    it('backoffs grow monotonically and cap at a sane steady-state', () => {




      for (let i = 1; i < SELF_HEAL_PROBE_BACKOFFS_MS.length; i++) {
        expect(SELF_HEAL_PROBE_BACKOFFS_MS[i]!).toBeGreaterThanOrEqual(
          SELF_HEAL_PROBE_BACKOFFS_MS[i - 1]!,
        );
      }
      expect(SELF_HEAL_PROBE_BACKOFFS_MS[SELF_HEAL_PROBE_BACKOFFS_MS.length - 1]).toBeLessThanOrEqual(10_000);
    });
  });
});

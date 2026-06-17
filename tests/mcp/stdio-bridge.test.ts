import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createProjectId, assertGroveProjectId } from '@myco/grove/ids.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import {
  REQUEST_CONTEXT_AUTH_HEADER,
  REQUEST_CONTEXT_HEADERS,
} from '@myco/grove/request-context.js';
import { resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  buildBridgeRequestHeaders,
  isParentGone,
  PARENT_WATCHDOG_INTERVAL_MS,
  DAEMON_HEARTBEAT_INTERVAL_MS,
  DAEMON_HEARTBEAT_FAILURE_THRESHOLD,
  UPSTREAM_SEND_TIMEOUT_MS,
  SELF_HEAL_PROBE_BACKOFFS_MS,
  REQUEST_RESEND_MAX_ATTEMPTS,
} from '@myco/mcp/stdio-bridge.js';

function withRegisteredProject<T>(fn: (args: {
  home: string;
  projectRoot: string;
  vaultDir: string;
  groveId: string;
  projectId: string;
}) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stdio-bridge-'));
  const previousHome = process.env.MYCO_HOME;
  try {
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'project');
    const vaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(vaultDir, { recursive: true });
    const grove = createGrove('Bridge Test', home);
    const projectId = assertGroveProjectId(createProjectId());
    saveProjectManifest(vaultDir, {
      project: { id: projectId, name: 'Bridge Project' },
      grove: { binding_id: 'gbind-bridge', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'Bridge Project',
      projectRoot,
      bindingId: 'gbind-bridge',
    }, home);
    return fn({ home, projectRoot, vaultDir, groveId: grove.id, projectId });
  } finally {
    if (previousHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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
  it('builds caller-tenancy headers from a registered launch context', () => {
    withRegisteredProject(({ projectRoot, vaultDir, groveId, projectId }) => {
      const headers = buildBridgeRequestHeaders(vaultDir, {}, 'secret-token');

      expect(headers[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe(projectRoot);
      expect(headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe(projectId);
      expect(headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe(groveId);
      expect(headers[REQUEST_CONTEXT_AUTH_HEADER]).toBe('secret-token');
    });
  });

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

    it('agent-death detection stays under 30 seconds', () => {
      // The only watchdog that EXITS the bridge is the parent-death
      // watchdog. Daemon-death no longer terminates the bridge — it
      // routes through the indefinite self-heal loop — so there is no
      // longer a "zombie window" tied to daemon health. The agent-death
      // window stays bounded so an orphaned bridge doesn't sit idle.
      expect(PARENT_WATCHDOG_INTERVAL_MS).toBeLessThan(30_000);
    });

    it('heartbeat threshold triggers self-heal, not bridge exit', () => {
      // Pinned so a "tweak this back to exit-on-failure" PR has to
      // engage with the contract. The bridge MUST survive daemon-down
      // so Claude Code's MCP supervisor doesn't lose the surface
      // (it doesn't auto-respawn — manual /mcp reconnect required
      // after a bridge exit). N missed heartbeats just trigger a
      // proactive reconnect for the idle-bridge case.
      expect(DAEMON_HEARTBEAT_FAILURE_THRESHOLD).toBe(2);
    });
  });

  describe('active-send self-heal constants (Bucket J)', () => {
    it('caps a single forwarded JSON-RPC message at UPSTREAM_SEND_TIMEOUT_MS', () => {
      // StreamableHTTPClientTransport.send() returns when the POST is
      // accepted — long tool calls stream back via SSE, not via the
      // send() return value — so 30 s is generous for a loopback POST
      // and short enough that a hung half-open socket on a dead daemon
      // doesn't sit waiting for OS TCP keepalive (often minutes).
      // Bucket J's original 120 s was too loose; user-visible hang on a
      // `make build` rebuild needs to be sub-10 s.
      expect(UPSTREAM_SEND_TIMEOUT_MS).toBe(30_000);
    });

    it('caps the per-message re-send loop at REQUEST_RESEND_MAX_ATTEMPTS', () => {
      // After self-heal succeeds, the bridge re-sends the dropped
      // message so the agent sees a real response instead of a hang.
      // 2 retries (3 total attempts incl. original) covers the realistic
      // restart-mid-call window without becoming a DoS amplifier when
      // the daemon is genuinely down.
      expect(REQUEST_RESEND_MAX_ATTEMPTS).toBe(2);
    });

    it('exposes an indefinite probe backoff schedule (the bridge never gives up on daemon-down)', () => {
      // The bridge retries forever because Claude Code's MCP supervisor
      // doesn't auto-respawn — exit would leave the agent's MCP surface
      // dead until manual /mcp reconnect. The schedule below tunes the
      // ramp from "fast catch quick restart" to "stable steady-state
      // retry while the daemon recovers from a longer outage".
      expect(SELF_HEAL_PROBE_BACKOFFS_MS.length).toBeGreaterThan(0);
    });

    it('backoffs grow monotonically and cap at a sane steady-state', () => {
      // Once past the last entry the reconnect loop holds at that value
      // indefinitely, so the cap controls battery / poll rate during a
      // long outage. 5 s is cheap (one fetch) and recovers quickly when
      // the daemon comes back.
      for (let i = 1; i < SELF_HEAL_PROBE_BACKOFFS_MS.length; i++) {
        expect(SELF_HEAL_PROBE_BACKOFFS_MS[i]!).toBeGreaterThanOrEqual(
          SELF_HEAL_PROBE_BACKOFFS_MS[i - 1]!,
        );
      }
      expect(SELF_HEAL_PROBE_BACKOFFS_MS[SELF_HEAL_PROBE_BACKOFFS_MS.length - 1]).toBeLessThanOrEqual(10_000);
    });
  });
});

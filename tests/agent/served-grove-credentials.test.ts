/**
 * Task 7 (server-mode design spec §5): served-grove secrets loading +
 * keyless-preflight suppression.
 *
 * Covers the brief's Step 1 (a)-(c):
 *   (a) a key present ONLY in the Grove's secrets.env layers into the run
 *       env, and a Grove secret wins over a same-named machine secret
 *       (more-specific wins).
 *   (b) a keyless cloud provider makes `gateScheduledDispatch` (the seam
 *       `dispatchScheduledTask` calls before every scheduled LLM dispatch)
 *       return 'missing_key' with a visible "no team key configured"
 *       status logged — never a call into the notification path that would
 *       emit `agent.task.failure`.
 *   (c) a key added mid-schedule is picked up by the very next tick's
 *       fresh layering call — no stale negative caching.
 *
 * `dispatchScheduledTask` itself is a closure inside `registerScheduledTasks`
 * and not exported — driving a full scheduler tick would need top-level
 * module mocks (`dispatchAgentRun`, `notify`) that risk poisoning other
 * test files sharing the bundled bun process (the exact rationale recorded
 * in `tests/daemon/scheduled-run-outcome.test.ts`). This file instead drives
 * the real exported seams directly: `loadLayeredSecrets` (real secrets.env
 * files on disk, hermetic MYCO_HOME — no mock of the loader) and
 * `gateScheduledDispatch` (the exact function `dispatchScheduledTask` calls
 * and returns on immediately for 'missing_key', before any
 * `dispatchAgentRun`/`notifyScheduledRunOutcome` call is reached).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLayeredSecrets, writeSecret, deleteSecrets } from '@myco/config/secrets.js';
import { __resetProviderHealthCache } from '@myco/agent/harness/provider-health.js';
import { gateScheduledDispatch } from '@myco/daemon/task-scheduling.js';
import { resolveServedGroveKeyHealth } from '@myco/daemon/host-serve.js';
import { loadMachineConfig, saveMachineConfig, loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { createGrove } from '@myco/grove/registry.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';

const TEST_PROJECT_ID = assertGroveProjectId(`proj_${'c'.repeat(32)}`);

interface LogCall { level: string; kind: string; message: string; data?: Record<string, unknown> }

function stubLogger(): { logger: DaemonLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const logger = {
    debug: (kind: string, message: string, data?: Record<string, unknown>) => calls.push({ level: 'debug', kind, message, data }),
    info: (kind: string, message: string, data?: Record<string, unknown>) => calls.push({ level: 'info', kind, message, data }),
    warn: (kind: string, message: string, data?: Record<string, unknown>) => calls.push({ level: 'warn', kind, message, data }),
    error: (kind: string, message: string, data?: Record<string, unknown>) => calls.push({ level: 'error', kind, message, data }),
  };
  return { logger: logger as unknown as DaemonLogger, calls };
}

describe('served-grove secrets loading + keyless-preflight suppression', () => {
  let workDir: string;
  let machineHome: string;
  let groveDir: string;
  const ENV_KEYS = ['ANTHROPIC_API_KEY'];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    __resetProviderHealthCache();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-served-grove-creds-'));
    machineHome = path.join(workDir, 'home');
    groveDir = path.join(workDir, 'groves', 'grove_test');
    fs.mkdirSync(machineHome, { recursive: true });
    fs.mkdirSync(groveDir, { recursive: true });
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('(a) grove secrets.env layers into the run env', () => {
    it('a key present ONLY in the grove secrets.env lands in process.env', () => {
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=grove-only-team-key\n');
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      loadLayeredSecrets([machineHome, groveDir]);

      expect(process.env.ANTHROPIC_API_KEY).toBe('grove-only-team-key');
    });

    it('the grove secret wins over a same-named machine secret (more-specific wins)', () => {
      fs.writeFileSync(path.join(machineHome, 'secrets.env'), 'ANTHROPIC_API_KEY=machine-personal-key\n');
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=grove-team-key\n');

      loadLayeredSecrets([machineHome, groveDir]);

      expect(process.env.ANTHROPIC_API_KEY).toBe('grove-team-key');
    });

    it('no grove secrets.env at all → machine secret still applies (grove is additive, not exclusive)', () => {
      fs.writeFileSync(path.join(machineHome, 'secrets.env'), 'ANTHROPIC_API_KEY=machine-only-key\n');

      loadLayeredSecrets([machineHome, groveDir]);

      expect(process.env.ANTHROPIC_API_KEY).toBe('machine-only-key');
    });
  });

  describe('(b) keyless cloud provider suppresses dispatch with a visible status', () => {
    it('missing key everywhere → gateScheduledDispatch returns missing_key and logs "no team key configured"', async () => {
      const { logger, calls } = stubLogger();

      const decision = await gateScheduledDispatch({
        provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } as any,
        taskName: 'vault-evolve',
        projectId: TEST_PROJECT_ID,
        logger,
      });

      expect(decision).toBe('missing_key');
      const infoCalls = calls.filter((c) => c.level === 'info');
      expect(infoCalls).toHaveLength(1);
      expect(infoCalls[0].message).toContain('no team key configured');
      expect(infoCalls[0].message).toContain('vault-evolve');
      expect(infoCalls[0].data).toMatchObject({ reason: 'missing_key', task: 'vault-evolve' });
      // Never any warn/error — a keyless box is an expected posture, not a fault.
      expect(calls.filter((c) => c.level === 'warn' || c.level === 'error')).toHaveLength(0);
    });

    it('the status string never echoes any key material — only the missing-key state', async () => {
      const { logger, calls } = stubLogger();
      await gateScheduledDispatch({
        provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } as any,
        taskName: 'vault-evolve',
        projectId: TEST_PROJECT_ID,
        logger,
      });
      const serialized = JSON.stringify(calls);
      expect(serialized).not.toMatch(/sk-[a-zA-Z0-9-]{6,}/);
    });

    it('a key present anywhere in env → proceed, no status logged', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-present';
      const { logger, calls } = stubLogger();

      const decision = await gateScheduledDispatch({
        provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } as any,
        taskName: 'vault-evolve',
        projectId: TEST_PROJECT_ID,
        logger,
      });

      expect(decision).toBe('proceed');
      expect(calls).toHaveLength(0);
    });

    it('no explicit provider override (claude-sdk subscription default) → proceed — missing_key never applies', async () => {
      const { logger, calls } = stubLogger();

      const decision = await gateScheduledDispatch({
        provider: undefined,
        taskName: 'title-summary',
        projectId: TEST_PROJECT_ID,
        logger,
      });

      expect(decision).toBe('proceed');
      expect(calls).toHaveLength(0);
    });

    it('a local provider (ollama) never requires a stored key — proceed regardless of ANTHROPIC_API_KEY', async () => {
      const { logger, calls } = stubLogger();

      const decision = await gateScheduledDispatch({
        provider: { type: 'ollama', baseUrl: undefined, model: 'm' } as any,
        taskName: 'vault-evolve',
        projectId: TEST_PROJECT_ID,
        logger,
      });

      expect(decision).toBe('proceed');
      expect(calls).toHaveLength(0);
    });
  });

  describe('(c) key added mid-schedule dispatches on the next tick', () => {
    it('missing at first tick, written to the grove secrets.env, present at the next tick', async () => {
      const { logger: logger1 } = stubLogger();
      const provider = { type: 'anthropic', model: 'claude-sonnet-4-6' } as any;

      // First tick: dispatchScheduledTask's own layering call, then the gate.
      loadLayeredSecrets([machineHome, groveDir]);
      const first = await gateScheduledDispatch({ provider, taskName: 'vault-evolve', projectId: TEST_PROJECT_ID, logger: logger1 });
      expect(first).toBe('missing_key');

      // Mid-schedule: the Team page (Task 8/9) writes the team key into the
      // served Grove's secrets.env via `writeSecret` — simulated here as a
      // direct file write, matching the on-disk shape `writeSecret` produces.
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=added-mid-schedule\n');

      // Next tick: dispatchScheduledTask re-layers from disk on every call
      // (no persistent in-memory "keyless" latch) and re-probes fresh — the
      // missing-key check is never cached, so this sees the new key immediately.
      const { logger: logger2, calls: calls2 } = stubLogger();
      loadLayeredSecrets([machineHome, groveDir]);
      const second = await gateScheduledDispatch({ provider, taskName: 'vault-evolve', projectId: TEST_PROJECT_ID, logger: logger2 });

      expect(second).toBe('proceed');
      expect(calls2).toHaveLength(0);
      expect(process.env.ANTHROPIC_API_KEY).toBe('added-mid-schedule');
    });
  });

  describe('fix round 1: repeated layering refreshes the keys it owns (update/delete without restart)', () => {
    it('key value UPDATED in grove secrets.env between ticks → next dispatch sees the NEW value', () => {
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=team-key-v1\n');
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('team-key-v1');

      // Rotation via PUT /api/team/secrets/:provider lands as a writeSecret
      // overwrite of the same provider-standard env name.
      writeSecret(groveDir, 'ANTHROPIC_API_KEY', 'team-key-v2');
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('team-key-v2');
    });

    it('key DELETED between ticks → env entry removed, next dispatch suppresses with missing_key', async () => {
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=team-key-revoked\n');
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('team-key-revoked');

      // Revocation via DELETE /api/team/secrets/:provider lands as
      // deleteSecrets of every alias for the provider.
      deleteSecrets(groveDir, ['ANTHROPIC_API_KEY']);
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      const { logger, calls } = stubLogger();
      const decision = await gateScheduledDispatch({
        provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } as any,
        taskName: 'vault-evolve',
        projectId: TEST_PROJECT_ID,
        logger,
      });
      expect(decision).toBe('missing_key');
      expect(calls.filter((c) => c.level === 'warn' || c.level === 'error')).toHaveLength(0);
    });

    it('key DELETED between polls → keyHealth reports missing_key (Team page/doctor see the revoked state)', () => {
      // Real designation fixture — the classifier itself calls
      // loadLayeredSecrets, so this reproduces the long-lived-daemon route
      // poll: first poll layers the key into process.env, then the key is
      // revoked on disk and the next poll must NOT keep reporting ok off
      // the stale env value.
      const grove = createGrove('Served', machineHome);
      const machine = loadMachineConfig(machineHome);
      saveMachineConfig({
        ...machine,
        daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: grove.id } },
      }, machineHome);
      const groveCfg = loadGroveConfig(grove.id, machineHome);
      saveGroveConfig(grove.id, { ...groveCfg, agent: { ...groveCfg.agent, provider: { type: 'anthropic' } } }, machineHome);
      const servedDir = resolveGroveDir(grove.id, machineHome);
      writeSecret(servedDir, 'ANTHROPIC_API_KEY', 'sk-ant-to-be-revoked');

      expect(resolveServedGroveKeyHealth(loadMachineConfig(machineHome), machineHome))
        .toEqual({ kind: 'ok', servedGroveId: grove.id });

      deleteSecrets(servedDir, ['ANTHROPIC_API_KEY']);
      expect(resolveServedGroveKeyHealth(loadMachineConfig(machineHome), machineHome))
        .toEqual({ kind: 'missing_key', servedGroveId: grove.id });
    });

    it('a boot-env var set before any layering is never clobbered or deleted by layering', () => {
      // Inherited shell/launchd env — never written by layering, so layering
      // must neither overwrite it with a file value nor delete it when the
      // file entry disappears.
      process.env.ANTHROPIC_API_KEY = 'boot-inherited-value';
      fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'ANTHROPIC_API_KEY=grove-file-value\n');
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('boot-inherited-value');

      fs.rmSync(path.join(groveDir, 'secrets.env'));
      loadLayeredSecrets([machineHome, groveDir]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('boot-inherited-value');
    });
  });
});

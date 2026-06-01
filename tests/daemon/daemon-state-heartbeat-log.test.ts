import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDaemonStateAuthority,
  type StateMutationLogger,
} from '@myco/daemon/daemon-state-authority.js';
import type {
  DaemonServiceState,
  DaemonState,
  DaemonStatePath,
} from '@myco/daemon/service-state.js';

interface CapturedLog {
  level: 'debug' | 'info';
  kind: string;
  message: string;
  outcome?: string;
}

function makeDaemonService(dir: string): DaemonServiceState {
  return {
    scope: 'global',
    stateDir: dir,
    statePath: join(dir, 'daemon.json') as DaemonStatePath,
    lockPath: join(dir, 'daemon.lock'),
    canonicalPort: 20915,
  };
}

function makeState(): DaemonState {
  return {
    pid: process.pid,
    port: 20915,
    command: process.execPath,
    started: '2026-06-01T00:00:00.000Z',
    sessions: [],
    version: '0.27.10',
    auth_token: 'tok-deadbeef',
  };
}

function makeCapturingLogger(logs: CapturedLog[]): StateMutationLogger {
  return {
    debug(kind, message, fields) {
      logs.push({ level: 'debug', kind, message, outcome: fields?.outcome as string | undefined });
    },
    info(kind, message, fields) {
      logs.push({ level: 'info', kind, message, outcome: fields?.outcome as string | undefined });
    },
  };
}

describe('DaemonStateAuthority heartbeat logging', () => {
  it('logs no-op heartbeat touches at debug while real mutations stay info', () => {
    const dir = mkdtempSync(join(tmpdir(), 'myco-daemon-state-heartbeat-'));
    try {
      const logs: CapturedLog[] = [];
      const authority = createDaemonStateAuthority(makeDaemonService(dir), makeCapturingLogger(logs));
      const state = makeState();

      authority.write(state, { reason: 'server-start-listen' });
      authority.writeOrTouch(state, { reason: 'self-reconcile:heartbeat' });

      const wrote = logs.find((log) => log.outcome === 'wrote');
      const touched = logs.find((log) => log.outcome === 'touched');
      expect(wrote?.level).toBe('info');
      expect(wrote?.message).toBe('daemon.json mutation');
      expect(touched?.level).toBe('debug');
      expect(touched?.message).toMatch(/heartbeat/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

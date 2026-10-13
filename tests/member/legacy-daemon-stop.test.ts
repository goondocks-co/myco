import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopHomeDaemon } from '@myco/member/legacy-daemon-stop.js';
import { readDaemonState, resolveGlobalDaemonPort } from '@myco/member/legacy-daemon-state.js';
import { resolveServiceDaemonStatePath, resolveServiceDir } from '@myco/paths/service.js';
import { derivePort } from '@myco/paths/ports.js';
import { WindowsTaskServiceManager, type SchtasksRunner } from '@myco/member/legacy-service/windows.js';

describe('retained legacy daemon stop', () => {
  it('never requests shutdown without a readable home PID, even if a daemon answers its fallback port', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-stop-'));
    const statePath = resolveServiceDaemonStatePath(home);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    for (const state of [undefined, '{', JSON.stringify({ port: 45678 })]) {
      if (state === undefined) fs.rmSync(statePath, { force: true });
      else fs.writeFileSync(statePath, state);
      expect(readDaemonState(statePath)).toBeNull();
      const methods: string[] = [];
      const fetchFn = (async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        return Response.json({ pid: 111 });
      }) as typeof fetch;
      expect(await stopHomeDaemon(home, fetchFn)).toBe('not-this-home');
      expect(methods).toEqual(['GET']);
    }
  });

  it('reads the legacy port override without migrating or rewriting configuration', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-port-'));
    const file = path.join(home, 'config.yaml');
    for (const config of ['daemon:\n  port: 45123\n', 'daemon:\n  port: 12\n', 'daemon: [']) {
      fs.writeFileSync(file, config);
      expect(resolveGlobalDaemonPort(home)).toBe(config.includes('45123') ? 45123 : derivePort(resolveServiceDir(home)));
      expect(fs.readFileSync(file, 'utf8')).toBe(config);
    }
  });

  it('the platform adapter refuses Windows hard termination without an explicit containment authority', async () => {
    const calls: string[] = [];
    const unexpected = async (): Promise<never> => { throw new Error('unexpected platform command'); };
    const runner: SchtasksRunner = {
      run: unexpected,
      register: unexpected,
      currentUserSid: unexpected,
      queryState: async () => 'running',
      endProcessTree: async () => { calls.push('end'); return { stdout: '', exitCode: 0 }; },
    };
    const mgr = new WindowsTaskServiceManager({ runner, resolveDaemonPort: () => null });
    await expect(mgr.uninstall('co.goondocks.myco.test')).rejects.toThrow(/containment/i);
    expect(calls).toEqual([]);
  });
});

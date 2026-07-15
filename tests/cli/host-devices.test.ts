/**
 * Operator control plane (Task 2.4) — key mint / devices list|evict / bearer rotate.
 * Hermetic: a fake CommandRunner (no headscale), an injected HostState, tmp dirs.
 * These ops are localhost-CLI-only by construction (not daemon routes), so the
 * member/operator boundary is proven structurally in host-enroll.test.ts; here we
 * prove each op wraps the pinned v0.29 headscale syntax and logs the right action.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOST_SERVE_BEARER_SECRET } from '@myco/constants';
import { readSecrets } from '@myco/config/secrets';
import { resolveHostServeBearer } from '@myco/daemon/host-serve';
import { readHostActionLog } from '@myco/host/action-log';
import type { CommandRunner } from '@myco/host/overlay-binaries';
import type { ServiceManager } from '@myco/service/types';

import {
  NotAHostError,
  evictDevice,
  listDevices,
  mintSetupKey,
  parseNodesList,
  rotateBearer,
} from '../../packages/myco-team/src/host/devices';
import type { HostState } from '../../packages/myco-team/src/host/state';

function fakeState(controlDir: string): HostState {
  return {
    host_id: 'host_abc', enabled_at: new Date().toISOString(), server_url: 'https://host:8080',
    overlay_address: '100.64.0.1', headscale_user: 'myco-host',
    headscale_version: '0.29.2', tailscale_version: '1.98.8', platform: 'darwin',
    headscale_bin: path.join(controlDir, 'headscale'), tailscale_bin: 'ts', tailscaled_bin: 'tsd',
  };
}

/** A CommandRunner that answers the headscale sub-commands the ops issue and records argv. */
function fakeHeadscale(calls: string[][]): CommandRunner {
  return {
    async run(command: string, args: string[]) {
      calls.push([command, ...args]);
      if (args.includes('users') && args.includes('create')) return { stdout: '{"user":{"id":"1"}}', exitCode: 0 };
      if (args.includes('users') && args.includes('list')) return { stdout: JSON.stringify([{ id: '1', name: 'myco-host' }]), exitCode: 0 };
      if (args.includes('preauthkeys') && args.includes('create')) return { stdout: '{"key":"tskey-auth-ONETIME"}', exitCode: 0 };
      if (args.includes('nodes') && args.includes('list')) {
        return { stdout: JSON.stringify([
          { id: '7', given_name: 'macbook', name: 'macbook.host', ip_addresses: ['100.64.0.5', 'fd7a::5'], last_seen: '2026-07-08T00:00:00Z', online: true },
          { id: '8', name: 'vps', ip_addresses: ['100.64.0.6'], last_seen: '2026-07-07T00:00:00Z', online: false },
        ]), exitCode: 0 };
      }
      if (args.includes('nodes') && args.includes('delete')) return { stdout: 'Node deleted', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  };
}

describe('operator control plane', () => {
  let controlDir: string;

  beforeEach(() => { controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ctrl-')); });
  afterEach(() => { fs.rmSync(controlDir, { recursive: true, force: true }); });

  test('key mint wraps `preauthkeys create`, returns the key, logs key-mint WITHOUT the key value', async () => {
    const calls: string[][] = [];
    const key = await mintSetupKey({ expiration: '2h' }, { runner: fakeHeadscale(calls), state: fakeState(controlDir), controlDir });
    expect(key).toBe('tskey-auth-ONETIME');
    // pinned v0.29 syntax: preauthkeys create --user <id> --expiration <dur> --output json
    const mintCall = calls.find((c) => c.includes('preauthkeys') && c.includes('create'));
    expect(mintCall).toContain('--user');
    expect(mintCall).toContain('2h');
    // The headscale admin socket is root-owned — every call routes through sudo.
    expect(mintCall![0]).toBe('sudo');
    const log = readHostActionLog(controlDir);
    expect(log.filter((r) => r.action === 'key-mint').length).toBe(1);
    expect(JSON.stringify(log)).not.toContain('tskey-auth-ONETIME'); // NEVER logs the key
  });

  test('devices list wraps `nodes list --output json` and parses the v0.29 shape', async () => {
    const calls: string[][] = [];
    const devices = await listDevices({ runner: fakeHeadscale(calls), state: fakeState(controlDir), controlDir });
    expect(calls.some((c) => c.includes('nodes') && c.includes('list') && c.includes('--output') && c.includes('json'))).toBe(true);
    // The headscale admin socket is root-owned — every call routes through sudo.
    expect(calls.every((c) => c[0] === 'sudo')).toBe(true);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ id: '7', name: 'macbook', overlay_ip: '100.64.0.5', online: true });
    expect(devices[1]).toMatchObject({ id: '8', name: 'vps', overlay_ip: '100.64.0.6', online: false });
  });

  test('devices evict wraps `nodes delete -i <id> --force` and logs the eviction', async () => {
    const calls: string[][] = [];
    await evictDevice('7', { runner: fakeHeadscale(calls), state: fakeState(controlDir), controlDir });
    const del = calls.find((c) => c.includes('delete'));
    expect(del).toEqual(expect.arrayContaining(['nodes', 'delete', '-i', '7', '--force']));
    // The headscale admin socket is root-owned — every call routes through sudo.
    expect(del![0]).toBe('sudo');
    const log = readHostActionLog(controlDir);
    expect(log.filter((r) => r.action === 'evict' && r.subject === '7').length).toBe(1);
  });

  test('control-plane ops on a non-host machine throw NotAHostError', async () => {
    await expect(mintSetupKey({}, { runner: fakeHeadscale([]), state: null, controlDir })).rejects.toThrow(NotAHostError);
    await expect(listDevices({ runner: fakeHeadscale([]), state: null, controlDir })).rejects.toThrow(NotAHostError);
    await expect(evictDevice('7', { runner: fakeHeadscale([]), state: null, controlDir })).rejects.toThrow(NotAHostError);
  });

  test('bearer rotate replaces the shared secret and logs the rotation', async () => {
    const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    try {
      const before = resolveHostServeBearer(mycoHome); // mints v1
      const unsupportedManager = { supported: false, platformName: 'test' } as unknown as ServiceManager;
      const result = await rotateBearer({ controlDir, mycoHome, serviceManager: unsupportedManager });
      const after = readSecrets(mycoHome)[HOST_SERVE_BEARER_SECRET];
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
      expect(result.daemonRestarted).toBe(false); // unsupported manager → operator restarts manually
      expect(readHostActionLog(controlDir).filter((r) => r.action === 'rotate').length).toBe(1);
    } finally {
      fs.rmSync(mycoHome, { recursive: true, force: true });
    }
  });

  test('parseNodesList accepts the {nodes:[…]} wrapper and skips id-less rows', () => {
    const wrapped = JSON.stringify({ nodes: [
      { id: '3', given_name: 'g', ip_addresses: ['100.64.0.3'], online: true },
      { name: 'no-id', ip_addresses: ['100.64.0.4'] }, // dropped (no id)
    ] });
    const parsed = parseNodesList(wrapped);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('3');
    expect(parseNodesList('not json')).toEqual([]);
  });
});

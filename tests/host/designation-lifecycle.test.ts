/**
 * Served-grove designation lifecycle (Task 3): how `hostEnable` designates a
 * Grove (create-or-reuse), why the designation never silently moves once
 * set, what protects the served Grove from deletion, and how a dangling
 * designation surfaces in `myco doctor`.
 */
import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DESIGNATION_INTENT_FILENAME,
  hostDisable,
  hostEnable,
  resolveServedGroveDesignation,
  type HostEnableDeps,
} from '@myco/team-host/overlay.js';
import { loadMachineConfig, saveMachineConfig } from '@myco/config/loader.js';
import { readHostState } from '@myco/team-host/state.js';
import { resolveServedGroveDesignationHealth } from '@myco/daemon/host-serve.js';
import { checkServedGroveDesignation } from '@myco/cli/doctor.js';
import {
  createGrove,
  deleteGrove,
  ensureDefaultGrove,
  listGroves,
  setDefaultGrove,
  ServedGroveUndeletableError,
} from '@myco/grove/registry.js';
import type { ServiceManager, ServiceStatus, InstallResult } from '@myco/service/types.js';

// ---------------------------------------------------------------------------
// Shared hermetic MYCO_HOME / MYCO_TEAM_HOME fixture
// ---------------------------------------------------------------------------

function withHermeticHomes(): { home: () => string; teamHome: () => string } {
  let home = '';
  let teamHome = '';
  let prevMyco: string | undefined;
  let prevTeam: string | undefined;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-designation-'));
    home = path.join(tmp, 'myco');
    teamHome = path.join(tmp, 'team');
    fs.mkdirSync(home, { recursive: true });
    prevMyco = process.env.MYCO_HOME;
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = home;
    process.env.MYCO_TEAM_HOME = teamHome;
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  return { home: () => home, teamHome: () => teamHome };
}

// ---------------------------------------------------------------------------
// (a) / (b): resolveServedGroveDesignation — the pure designation step
// ---------------------------------------------------------------------------

describe('resolveServedGroveDesignation', () => {
  const { home, teamHome } = withHermeticHomes();
  let notes: string[];
  const log = (m: string) => notes.push(m);

  beforeEach(() => { notes = []; });

  function controlDir(): string {
    return path.join(teamHome(), 'host');
  }

  test('(a) no designation, mode "default" → resolves/creates the default Grove', () => {
    expect(listGroves(home())).toHaveLength(0);

    const result = resolveServedGroveDesignation('default', undefined, home(), controlDir(), log);

    const groves = listGroves(home());
    expect(groves).toHaveLength(1);
    expect(groves[0].slug).toBe('default');
    expect(result.groveId).toBe(groves[0].id);
    expect(result.warning).toBeUndefined();
  });

  test('(a) no designation, mode "default" reuses an EXISTING default Grove rather than creating a second one', () => {
    const existingDefault = ensureDefaultGrove(home());

    const result = resolveServedGroveDesignation('default', undefined, home(), controlDir(), log);

    expect(result.groveId).toBe(existingDefault.id);
    expect(listGroves(home())).toHaveLength(1);
  });

  test('(b) re-run with a designation present and a MOVED default pointer does NOT re-point — warns instead', () => {
    const servedGrove = ensureDefaultGrove(home()); // designated grove, currently also the default
    const otherGrove = createGrove('Personal', home());
    setDefaultGrove(otherGrove.id, home()); // the default pointer moves elsewhere

    const result = resolveServedGroveDesignation('default', servedGrove.id, home(), controlDir(), log);

    // Designation is immutable once set — never silently re-derived from the
    // (now-moved) default pointer.
    expect(result.groveId).toBe(servedGrove.id);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/default/i);
    expect(notes.some((n) => /WARNING/.test(n))).toBe(true);
    // No third Grove was minted as a side effect of the mismatch check.
    expect(listGroves(home())).toHaveLength(2);
  });

  test('re-run with a designation present and the default pointer UNCHANGED → verifies silently, no warning', () => {
    const servedGrove = ensureDefaultGrove(home());

    const result = resolveServedGroveDesignation('default', servedGrove.id, home(), controlDir(), log);

    expect(result.groveId).toBe(servedGrove.id);
    expect(result.warning).toBeUndefined();
    expect(notes).toHaveLength(0);
  });

  test('an existing designation naming a Grove that no longer exists (dangling) is preserved verbatim, with a warning', () => {
    const missingId = `grove_${'0'.repeat(32)}`;

    const result = resolveServedGroveDesignation('default', missingId, home(), controlDir(), log);

    expect(result.groveId).toBe(missingId);
    expect(result.warning).toBeDefined();
    // Never silently re-derives a replacement designation.
    expect(listGroves(home())).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // (c) create-fresh crash recovery
  // -------------------------------------------------------------------------

  test('(c) mode "fresh": first run creates a Grove and records the crash-resumable intent marker BEFORE any designation is persisted', () => {
    const result = resolveServedGroveDesignation('fresh', undefined, home(), controlDir(), log);

    const groves = listGroves(home());
    expect(groves).toHaveLength(1);
    expect(result.groveId).toBe(groves[0].id);

    const markerPath = path.join(controlDir(), DESIGNATION_INTENT_FILENAME);
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(marker.grove_id).toBe(result.groveId);
  });

  test('(c) mode "fresh": crash between create and designate — a re-run (still no persisted designation) adopts the intent-marker Grove instead of minting a second one', () => {
    const first = resolveServedGroveDesignation('fresh', undefined, home(), controlDir(), log);
    expect(listGroves(home())).toHaveLength(1);

    // Simulate the crash: `writeHostServeConfig` never ran, so the caller's
    // "existing designation" is still absent on the re-run — exactly what
    // `hostEnable` would pass after restarting from scratch.
    const second = resolveServedGroveDesignation('fresh', undefined, home(), controlDir(), log);

    expect(second.groveId).toBe(first.groveId);
    expect(listGroves(home())).toHaveLength(1); // never a second orphan Grove
    expect(notes.some((n) => /adopt/i.test(n))).toBe(true);
  });

  test('a corrupt/unreadable intent marker is treated as absent — falls through to create fresh rather than throwing', () => {
    fs.mkdirSync(controlDir(), { recursive: true });
    fs.writeFileSync(path.join(controlDir(), DESIGNATION_INTENT_FILENAME), '{not json', 'utf-8');

    expect(() => resolveServedGroveDesignation('fresh', undefined, home(), controlDir(), log)).not.toThrow();
    expect(listGroves(home())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// hostEnable wiring — proves the designation step is actually reached and
// persisted through the real orchestrator, not just the internal helper.
// ---------------------------------------------------------------------------

describe('hostEnable designation wiring', () => {
  const { home, teamHome } = withHermeticHomes();
  let launchDaemonsDir: string;
  let brewDir: string;

  beforeEach(() => {
    fs.mkdtempSync(path.join(os.tmpdir(), 'myco-designation-hostenable-'));
  });

  // `hostEnable` no longer provisions binaries, renders a control plane, or
  // installs services, so the harness that faked all three is gone with them.
  // What survives is the only side effect these tests ever asserted on:
  // designation, persisted to machine config.
  function deps(overrides: Partial<HostEnableDeps> = {}): HostEnableDeps {
    return {
      mycoHome: home(),
      platform: 'darwin',
      restartDaemon: async () => ({ restarted: true, detail: 'restarted (fake)' }),
      logger: () => {},
      ...overrides,
    };
  }

  it('disable is idempotent on a machine that never enabled — clears nothing, reports success', async () => {
    // Teardown used to have to stop two services and prove them gone before
    // destroying identity. It is now three disk writes, so "never enabled" and
    // "enabled then torn down" converge on the same state rather than the
    // never-enabled case tripping a prove-gone gate with nothing to prove.
    const result = await hostDisable(deps());
    expect(result.cleared).toBe(true);
    expect(result.errors).toEqual([]);
    expect(readHostState()).toBeNull();
  });

  it('a FAILED URL withdrawal KEEPS the evidence — the leftover exposure stays findable', async () => {
    // The ordering exists so a live public URL is never stranded with nothing
    // on disk to point at it. Clearing on the failure branch would strand
    // exactly that: `host_serve.enabled` and the host state file are the only
    // things the boot sweep's retire intent keys on, so a transient Tailscale
    // failure would publish a URL forever with no mechanism left to find it.
    await hostEnable({ hostname: 'testhost' }, deps());
    expect(readHostState()).not.toBeNull();

    const result = await hostDisable(deps({
      withdrawFunnel: async () => ({ ok: false, detail: 'tailscale is not reachable' }),
    }));

    // Reported, not silent.
    expect(result.cleared).toBe(false);
    expect(result.errors.join(' ')).toContain('KEPT');
    // And the evidence survives, so the next attempt can still find the URL.
    expect(loadMachineConfig(home()).daemon.host_serve.enabled).toBe(true);
    expect(readHostState()).not.toBeNull();
    // Serving still stops: the daemon restart is what unbinds the socket.
    expect(result.daemonRestarted).toBe(true);
  });

  it('a SUCCESSFUL withdrawal clears the evidence as before', async () => {
    await hostEnable({ hostname: 'testhost' }, deps());

    const result = await hostDisable(deps({
      withdrawFunnel: async () => ({ ok: true, detail: 'withdrawn' }),
    }));

    expect(result.cleared).toBe(true);
    expect(result.errors).toEqual([]);
    expect(loadMachineConfig(home()).daemon.host_serve.enabled).toBe(false);
    expect(readHostState()).toBeNull();
  });

  it('(a) enable with no designation designates the default Grove and persists it', async () => {
    const result = await hostEnable({ hostname: 'testhost' }, deps());

    expect(result.servedGroveId).toBeDefined();
    const machine = loadMachineConfig(home());
    expect(machine.daemon.host_serve.served_grove_id).toBe(result.servedGroveId);

    const groves = listGroves(home());
    expect(groves).toHaveLength(1);
    expect(groves[0].slug).toBe('default');
    expect(groves[0].id).toBe(result.servedGroveId);
  });

  it('(b) re-run after the default pointer moves keeps the original designation and surfaces a warning note', async () => {
    const first = await hostEnable({ hostname: 'testhost' }, deps());

    const otherGrove = createGrove('Personal', home());
    setDefaultGrove(otherGrove.id, home());

    const second = await hostEnable({ hostname: 'testhost' }, deps());

    expect(second.servedGroveId).toBe(first.servedGroveId);
    const machine = loadMachineConfig(home());
    expect(machine.daemon.host_serve.served_grove_id).toBe(first.servedGroveId);
    expect(second.notes.some((n) => /default/i.test(n))).toBe(true);
  });

  it('mode "fresh" creates a dedicated Grove (never the pre-existing default) and clears the intent marker once designated', async () => {
    const personalDefault = ensureDefaultGrove(home()); // a pre-existing personal default Grove

    const result = await hostEnable(
      { hostname: 'testhost', groveDesignation: 'fresh' },
      deps(),
    );

    expect(result.servedGroveId).toBeDefined();
    expect(result.servedGroveId).not.toBe(personalDefault.id);

    const groves = listGroves(home());
    expect(groves).toHaveLength(2); // the personal default + the fresh served Grove
    expect(groves.map((g) => g.id)).toContain(result.servedGroveId);

    const markerPath = path.join(teamHome(), 'host', DESIGNATION_INTENT_FILENAME);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) delete guard
// ---------------------------------------------------------------------------

describe('deleteGrove refuses the served Grove', () => {
  const { home } = withHermeticHomes();

  function designate(groveId: string): void {
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: {
        ...machine.daemon,
        host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: groveId },
      },
    }, home());
  }

  test('(d) deleting the served Grove refuses, even with force', () => {
    ensureDefaultGrove(home()); // a second Grove, so the served Grove is neither default nor last
    const servedGrove = createGrove('Team Host', home());
    designate(servedGrove.id);

    expect(() => deleteGrove(servedGrove.id, {}, home())).toThrow(ServedGroveUndeletableError);
    expect(() => deleteGrove(servedGrove.id, { force: true }, home())).toThrow(ServedGroveUndeletableError);

    // Never deleted.
    expect(listGroves(home()).map((g) => g.id)).toContain(servedGrove.id);
  });

  test('deleting a Grove that is NOT the served Grove is unaffected', () => {
    ensureDefaultGrove(home());
    const servedGrove = createGrove('Team Host', home());
    const other = createGrove('Scratch', home());
    designate(servedGrove.id);

    expect(() => deleteGrove(other.id, {}, home())).not.toThrow();
    expect(listGroves(home()).map((g) => g.id)).not.toContain(other.id);
  });
});

// ---------------------------------------------------------------------------
// (e) doctor finding
// ---------------------------------------------------------------------------

describe('checkServedGroveDesignation (doctor)', () => {
  const { home } = withHermeticHomes();

  function writeHostServe(hostServe: { enabled?: boolean; served_grove_id?: string | null }): void {
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, ...hostServe } },
    }, home());
  }

  test('(e) enabled with served_grove_id naming no Grove on this machine → warn row reporting a dangling designation', async () => {
    const missingId = `grove_${'1'.repeat(32)}`;
    writeHostServe({ enabled: true, served_grove_id: missingId });

    const check = await checkServedGroveDesignation();

    expect(check).not.toBeNull();
    expect(check!.status).toBe('warn');
    expect(check!.detail).toMatch(/dangling|no Grove/i);
    expect(check!.detail).toContain(missingId);
  });

  test('serving disabled → no row', async () => {
    writeHostServe({ enabled: false, served_grove_id: null });
    expect(await checkServedGroveDesignation()).toBeNull();
  });

  test('enabled, undesignated (null) → no row — fail-closed serving is not an error state', async () => {
    writeHostServe({ enabled: true, served_grove_id: null });
    expect(await checkServedGroveDesignation()).toBeNull();
  });

  test('enabled, designated to an existing Grove → no row (healthy)', async () => {
    const grove = ensureDefaultGrove(home());
    writeHostServe({ enabled: true, served_grove_id: grove.id });
    expect(await checkServedGroveDesignation()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveServedGroveDesignationHealth — the pure classifier under the doctor row
// ---------------------------------------------------------------------------

describe('resolveServedGroveDesignationHealth', () => {
  const { home } = withHermeticHomes();

  test('classifies not_serving / undesignated / ok / dangling', () => {
    const off = loadMachineConfig(home());
    expect(resolveServedGroveDesignationHealth(off, home())).toEqual({ kind: 'not_serving' });

    const grove = ensureDefaultGrove(home());
    saveMachineConfig({ ...off, daemon: { ...off.daemon, host_serve: { ...off.daemon.host_serve, enabled: true, served_grove_id: null } } }, home());
    const undesignated = loadMachineConfig(home());
    expect(resolveServedGroveDesignationHealth(undesignated, home())).toEqual({ kind: 'undesignated' });

    saveMachineConfig({ ...off, daemon: { ...off.daemon, host_serve: { ...off.daemon.host_serve, enabled: true, served_grove_id: grove.id } } }, home());
    const ok = loadMachineConfig(home());
    expect(resolveServedGroveDesignationHealth(ok, home())).toEqual({ kind: 'ok', servedGroveId: grove.id });

    const missingId = `grove_${'2'.repeat(32)}`;
    saveMachineConfig({ ...off, daemon: { ...off.daemon, host_serve: { ...off.daemon.host_serve, enabled: true, served_grove_id: missingId } } }, home());
    const dangling = loadMachineConfig(home());
    expect(resolveServedGroveDesignationHealth(dangling, home())).toEqual({ kind: 'dangling', servedGroveId: missingId });
  });
});

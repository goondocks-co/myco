/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * `myco doctor` reports — and `--fix` removes — state left by a machine that
 * ran per-host networking.
 *
 * This is the only part of the transport change that touches a real machine.
 * Source deletions cost nothing on a box that already upgraded; these files sit
 * in a user's home until something removes them, and nothing else ever will:
 * they are not read, not migrated, and leaving a host does not clean them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkOverlayResidue } from '@myco/cli/doctor';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import type { DoctorCheck } from '@myco/cli/doctor';
import type { DoctorFixContext } from '@myco/cli/doctor-fixes';

describe('doctor: per-host networking residue', () => {
  let tmp: string;
  let teamsHome: string;
  let homeDir: string;
  let unitDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-overlay-residue-'));
    teamsHome = path.join(tmp, 'team');
    homeDir = path.join(tmp, 'home');
    unitDir = path.join(tmp, 'units');
    for (const d of [teamsHome, homeDir, unitDir]) fs.mkdirSync(d, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const check = () => checkOverlayResidue({ teamsHome, homeDir, serviceUnitDir: unitDir });
  const seed = (...parts: string[]) => {
    const p = path.join(...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  test('a machine that never hosted or joined reports NOTHING', async () => {
    // A healthy doctor prints no row. A check that always fires is noise, and
    // noise is what gets a doctor ignored.
    expect(await check()).toBeNull();
  });

  test('leftover state is reported and NAMED', async () => {
    const socketDir = seed(homeDir, '.myco-ts');
    const headscale = seed(teamsHome, 'host', 'headscale');

    const result = await check();
    expect(result?.status).toBe('warn');
    expect(result?.fixable).toBe(true);
    expect(result?.detail).toContain(socketDir);
    expect(result?.detail).toContain(headscale);
  });

  test('per-host node state is found under EVERY joined host', async () => {
    const a = seed(teamsHome, 'hosts', 'host_aaaa', 'tailscaled-state');
    const b = seed(teamsHome, 'hosts', 'host_bbbb', 'tailscaled-state');
    // A host dir with no leftover must not be invented as residue.
    seed(teamsHome, 'hosts', 'host_cccc');

    const result = await check();
    expect(result?.fixData?.paths).toEqual(expect.arrayContaining([a, b]));
    expect((result?.fixData?.paths as string[]).some((p) => p.includes('host_cccc'))).toBe(false);
  });

  test("a user's OWN Tailscale unit is never reported as ours", async () => {
    // The machine-wide install is not Myco's to comment on, let alone remove.
    fs.writeFileSync(path.join(unitDir, 'com.tailscale.tailscaled.plist'), 'x');
    expect(await check()).toBeNull();
  });

  test('a Myco networking unit IS reported, but is NOT fixable', async () => {
    // A loaded unit outlives its file: unlinking it orphans a running process
    // with no supervisor entry, which is worse than leaving it.
    const unit = path.join(unitDir, 'com.myco.tailscaled.abc123.plist');
    fs.writeFileSync(unit, 'x');

    const result = await check();
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain(unit);
    expect(result?.fixable).toBe(false);
    expect(result?.detail).toMatch(/by hand/);
  });

  test('--fix removes the data, leaves the unit, and the machine then reports clean', async () => {
    const socketDir = seed(homeDir, '.myco-ts');
    const binDir = seed(teamsHome, 'member', 'bin');
    const unit = path.join(unitDir, 'com.myco.headscale.plist');
    fs.writeFileSync(unit, 'x');

    const found = await check();
    const actions = await DOCTOR_FIXERS['overlay-residue'](
      {} as DoctorFixContext,
      [found as DoctorCheck],
    );

    expect(fs.existsSync(socketDir)).toBe(false);
    expect(fs.existsSync(binDir)).toBe(false);
    // The unit is untouched, and still reported afterwards.
    expect(fs.existsSync(unit)).toBe(true);
    expect(actions.join('\n')).toContain(socketDir);

    const after = await check();
    expect(after?.fixable).toBe(false);
    expect(after?.detail).toContain(unit);
  });

  test('--fix on a path that vanished since the scan is a no-op, not an error', async () => {
    const socketDir = seed(homeDir, '.myco-ts');
    const found = await check();
    fs.rmSync(socketDir, { recursive: true, force: true });

    const actions = await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);
    expect(actions.join('\n')).not.toMatch(/Could not remove/);
  });
});

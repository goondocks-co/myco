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
import { memberHostTag } from '@myco/grove/paths';
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

  test('a broken HOME proposes NOTHING — never a relative path', async () => {
    // `os.homedir()` returns '' on a broken environment, and
    // `path.join('', '.myco-ts')` is RELATIVE — `rmSync` would resolve it
    // against the working directory, so `doctor --fix` inside a project could
    // delete a directory there. Verified by planting the bait in cwd.
    const bait = path.join(process.cwd(), '.myco-ts');
    const preexisting = fs.existsSync(bait);
    if (!preexisting) fs.mkdirSync(bait, { recursive: true });
    try {
      for (const brokenHome of ['', '.', 'relative/path']) {
        const result = await checkOverlayResidue({ teamsHome, homeDir: brokenHome, serviceUnitDir: unitDir });
        const proposed = (result?.fixData?.paths as string[] | undefined) ?? [];
        expect(proposed.every((p) => path.isAbsolute(p))).toBe(true);
        expect(proposed.some((p) => p.endsWith('.myco-ts'))).toBe(false);
      }
      expect(fs.existsSync(bait)).toBe(true);
    } finally {
      if (!preexisting) fs.rmSync(bait, { recursive: true, force: true });
    }
  });

  test('the filesystem ROOT as an anchor proposes nothing', async () => {
    const result = await checkOverlayResidue({ teamsHome: path.parse(process.cwd()).root, homeDir, serviceUnitDir: unitDir });
    const proposed = (result?.fixData?.paths as string[] | undefined) ?? [];
    expect(proposed.some((p) => p.split(path.sep).filter(Boolean).length < 2)).toBe(false);
  });

  test('a SYMLINK planted at a residue name is unlinked, and its target survives', async () => {
    // The link is reported (existsSync follows it). Removing it must not reach
    // through to whatever it points at.
    const precious = seed(tmp, 'precious');
    fs.writeFileSync(path.join(precious, 'data.txt'), 'user data');
    fs.symlinkSync(precious, path.join(homeDir, '.myco-ts'));

    const found = await check();
    await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);

    expect(fs.existsSync(path.join(homeDir, '.myco-ts'))).toBe(false);
    expect(fs.readFileSync(path.join(precious, 'data.txt'), 'utf8')).toBe('user data');
  });

  test('the TEMP-dir socket fallbacks are swept, by exact name only', async () => {
    // These are the one SHARED directory in the delete list, so the names must
    // be exact. A neighbouring file that merely looks similar must survive.
    const tmpDir = seed(tmp, 'tmpdir');
    seed(teamsHome, 'hosts', 'host_aaaa');
    const uid = process.getuid?.() ?? 0;
    // The SAME function production names sockets with — recomputing the digest
    // here would only prove the test agrees with itself.
    const tag = memberHostTag('host_aaaa');

    const hostSock = path.join(tmpDir, `myco-td-${uid}-host.sock`);
    const memberSock = path.join(tmpDir, `myco-td-${uid}-${tag}.sock`);
    const otherUser = path.join(tmpDir, `myco-td-${uid + 1}-host.sock`);
    const lookalike = path.join(tmpDir, 'myco-td-something-else.sock');
    const unrelated = path.join(tmpDir, 'myco-other.sock');
    for (const f of [hostSock, memberSock, otherUser, lookalike, unrelated]) fs.writeFileSync(f, '');

    const found = await checkOverlayResidue({ teamsHome, homeDir, serviceUnitDir: unitDir, tmpDir });
    await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);

    expect(fs.existsSync(hostSock)).toBe(false);
    expect(fs.existsSync(memberSock)).toBe(false);
    // Another uid's socket, a lookalike, and anything else are not ours.
    expect(fs.existsSync(otherUser)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test('an unusable TEMP dir proposes no temp path', async () => {
    seed(teamsHome, 'hosts', 'host_aaaa');
    for (const badTmp of ['', '.', 'relative']) {
      const result = await checkOverlayResidue({ teamsHome, homeDir, serviceUnitDir: unitDir, tmpDir: badTmp });
      const proposed = (result?.fixData?.paths as string[] | undefined) ?? [];
      expect(proposed.every((p) => path.isAbsolute(p))).toBe(true);
      expect(proposed.some((p) => p.endsWith('.sock'))).toBe(false);
    }
  });

  test('--fix on a path that vanished since the scan is a no-op, not an error', async () => {
    const socketDir = seed(homeDir, '.myco-ts');
    const found = await check();
    fs.rmSync(socketDir, { recursive: true, force: true });

    const actions = await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);
    expect(actions.join('\n')).not.toMatch(/Could not remove/);
  });
});

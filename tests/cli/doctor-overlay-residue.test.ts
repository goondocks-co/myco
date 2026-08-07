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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { checkOverlayResidue, runChecks } from '@myco/cli/doctor';
import { memberHostTag } from '@myco/grove/paths';
import { DOCTOR_FIXERS } from '@myco/cli/doctor-fixes';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
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

  test('the provisioned control-plane binaries are found', async () => {
    // A real machine kept 48 MB in `host/bin` through a full teardown. No
    // named resolver produces that path — it was joined inline — so a source
    // search concludes it is a phantom and drops it. This case is the evidence
    // that it is not.
    const hostBin = seed(teamsHome, 'host', 'bin');
    fs.writeFileSync(path.join(hostBin, 'headscale'), 'binary');

    const result = await check();
    expect(result?.fixData?.paths as string[]).toContain(hostBin);
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

  test('a leftover a LIVE process is still using is reported, never deleted', async () => {
    // Found on a real machine: an orphaned per-host tailscaled from an old
    // smoke was still accepting on `~/.myco-ts/<tag>.sock`. Deleting that
    // directory would have left the process running with no control socket —
    // the same reason a loaded service unit is reported rather than removed.
    const socketDir = seed(homeDir, '.myco-ts');
    const sockPath = path.join(socketDir, 'abc1234567.sock');
    const listening = net.createServer();
    await new Promise<void>((r) => listening.listen(sockPath, () => r()));

    // Unrelated residue in the same run must STILL be cleanable.
    const headscale = seed(teamsHome, 'host', 'headscale');
    try {
      const found = await check();
      expect(found?.detail).toContain('still IN USE');
      expect(found?.detail).toContain(socketDir);
      expect(found?.fixData?.paths as string[]).not.toContain(socketDir);

      await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);
      expect(fs.existsSync(sockPath)).toBe(true);
      expect(fs.existsSync(headscale)).toBe(false);
    } finally {
      await new Promise<void>((r) => listening.close(() => r()));
    }
  });

  test('a DEAD socket does not block cleanup — the liveness probe must be real', async () => {
    // The earlier version of this case substituted a REGULAR FILE for a dead
    // socket, so `isSocket()` was false and the liveness path never ran — it
    // passed while the probe reported EVERY socket as live (`net.connect` is
    // async, so a try/catch around it catches nothing). That defect would have
    // made any directory holding a dead socket permanently unfixable.
    //
    // A genuinely dead socket needs an owner that died WITHOUT cleaning up, so
    // this kills a child with SIGKILL and leaves the inode behind.
    const socketDir = seed(homeDir, '.myco-ts');
    const sockPath = path.join(socketDir, 'dead123456.sock');
    const child = spawn(process.execPath, ['-e',
      `const net=require('net');const s=net.createServer();s.listen(${JSON.stringify(sockPath)},()=>console.log('up'));setInterval(()=>{},1000);`,
    ]);
    await new Promise((r) => child.stdout!.once('data', r));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    expect(fs.lstatSync(sockPath).isSocket()).toBe(true);

    const found = await check();
    expect(found?.detail ?? '').not.toContain('still IN USE');
    expect(found?.fixData?.paths as string[]).toContain(socketDir);
  }, 30_000);

  test('WIRING: runChecks reports it OUTSIDE a project directory', async () => {
    // Every other case here calls `checkOverlayResidue` directly, so none of
    // them exercise where it sits in `runChecks`. It was placed AFTER the
    // no-config early return, so a `doctor` run from a home directory — the
    // likeliest moment to run one after upgrading — never reached it. Only
    // running the real binary on a real machine surfaced that.
    //
    // Anchored on the TEAM home, not the home dir: `os.homedir()` ignores
    // `process.env.HOME` under Bun, so a home-dir-based fixture would silently
    // scan the developer's REAL home and could pass for the wrong reason.
    const hostBin = seed(teamsHome, 'host', 'bin');
    fs.writeFileSync(path.join(hostBin, 'headscale'), 'binary');

    const savedTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamsHome;
    try {
      const checks = await runChecks(path.join(tmp, 'not-a-project'), testPerUserLockNamespace);
      const row = checks.find((c) => c.name === 'Team transport');
      expect(row, 'no Team transport row outside a project directory').toBeTruthy();
      // THIS fixture's residue, so a developer's own leftovers cannot satisfy it.
      expect(row?.detail).toContain(hostBin);
    } finally {
      if (savedTeam === undefined) delete process.env.MYCO_TEAM_HOME;
      else process.env.MYCO_TEAM_HOME = savedTeam;
    }
  }, 60_000);

  test('--fix on a path that vanished since the scan is a no-op, not an error', async () => {
    const socketDir = seed(homeDir, '.myco-ts');
    const found = await check();
    fs.rmSync(socketDir, { recursive: true, force: true });

    const actions = await DOCTOR_FIXERS['overlay-residue']({} as DoctorFixContext, [found as DoctorCheck]);
    expect(actions.join('\n')).not.toMatch(/Could not remove/);
  });
});

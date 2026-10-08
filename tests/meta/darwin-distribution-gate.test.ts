import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.skipIf(process.platform === 'win32')('the Darwin distribution gate rejects signature, version, launch, byte and packed-mode failures', () => {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'myco-darwin-gate-contract-'));
  try {
    const bin = path.join(scratch, 'bin');
    const packageBin = path.join(scratch, 'package', 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(packageBin, { recursive: true });
    const asset = path.join(scratch, 'myco-darwin-arm64');
    const packed = path.join(packageBin, 'myco');
    const tarball = path.join(scratch, 'platform.tgz');
    const calls = path.join(scratch, 'calls');
    const fixture = '#!/usr/bin/env bash\nprintf "launch\\n" >> "$MYCO_GATE_CALLS"\nprintf "%s\\n" "$MYCO_GATE_VERSION"\nexit "${MYCO_GATE_LAUNCH_EXIT:-0}"\n';
    fs.writeFileSync(asset, fixture);
    fs.writeFileSync(packed, fixture);
    fs.chmodSync(packed, 0o755);
    const codesign = path.join(bin, 'codesign');
    fs.writeFileSync(codesign, '#!/usr/bin/env bash\n[ "$1 $2" = "--verify --strict" ] || exit 99\nprintf "verify\\n" >> "$MYCO_GATE_CALLS"\nexit "${MYCO_GATE_SIGNATURE_EXIT:-0}"\n');
    fs.chmodSync(codesign, 0o755);
    const pack = () => execFileSync('tar', ['-czf', tarball, '-C', scratch, 'package/bin/myco']);
    const verify = (overrides: Record<string, string> = {}) => {
      fs.writeFileSync(calls, '');
      const result = spawnSync('bash', ['scripts/verify-darwin-distribution.sh', '1.2.3', asset, tarball, 'native'], {
        env: { ...process.env, RUNNER_TEMP: scratch, PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_GATE_CALLS: calls,
          MYCO_GATE_VERSION: '1.2.3', ...overrides }, encoding: 'utf8', timeout: 10_000,
      });
      if (result.error) throw result.error;
      return result;
    };
    pack();
    const accepted = verify();
    expect(accepted.stderr).toBe('');
    expect(accepted.status).toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\nverify\nlaunch\nlaunch\n');
    const refused = verify({ MYCO_GATE_SIGNATURE_EXIT: '17' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('invalid code signature; refusing distribution verification');
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\n');
    expect(verify({ MYCO_GATE_VERSION: '1.2.4' }).status).toBe(1);
    expect(verify({ MYCO_GATE_LAUNCH_EXIT: '23' }).status).toBe(23);
    fs.chmodSync(packed, 0o644);
    pack();
    expect(verify().status).toBe(1);
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\nverify\n');
    fs.chmodSync(packed, 0o755);
    fs.writeFileSync(packed, fixture + '\n');
    pack();
    expect(verify().status).not.toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\nverify\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

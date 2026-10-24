import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test.skipIf(process.platform === 'win32')('the Darwin distribution gate rejects signature, version, launch, byte and manifest failures', () => {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'myco-darwin-gate-contract-'));
  try {
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    const asset = path.join(scratch, 'myco-darwin-arm64');
    const manifest = path.join(scratch, 'SHA256SUMS');
    const calls = path.join(scratch, 'calls');
    const fixture = '#!/usr/bin/env bash\nprintf "launch\\n" >> "$MYCO_GATE_CALLS"\nprintf "%s\\n" "$MYCO_GATE_VERSION"\nexit "${MYCO_GATE_LAUNCH_EXIT:-0}"\n';
    fs.writeFileSync(asset, fixture);
    const codesign = path.join(bin, 'codesign');
    fs.writeFileSync(codesign, '#!/usr/bin/env bash\n[ "$1 $2" = "--verify --strict" ] || exit 99\nprintf "verify\\n" >> "$MYCO_GATE_CALLS"\nexit "${MYCO_GATE_SIGNATURE_EXIT:-0}"\n');
    fs.chmodSync(codesign, 0o755);
    const checksum = () => fs.writeFileSync(manifest, `${crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex')}  ${path.basename(asset)}\n`);
    const verify = (overrides: Record<string, string> = {}) => {
      fs.writeFileSync(calls, '');
      const result = spawnSync('bash', ['scripts/verify-darwin-distribution.sh', '1.2.3', asset, manifest, 'native'], {
        env: { ...process.env, RUNNER_TEMP: scratch, PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_GATE_CALLS: calls,
          MYCO_GATE_VERSION: '1.2.3', ...overrides }, encoding: 'utf8', timeout: 10_000,
      });
      if (result.error) throw result.error;
      return result;
    };
    checksum();
    const accepted = verify();
    expect(accepted.stderr).toBe('');
    expect(accepted.status).toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\nlaunch\n');
    const refused = verify({ MYCO_GATE_SIGNATURE_EXIT: '17' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('invalid code signature; refusing distribution verification');
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\n');
    expect(verify({ MYCO_GATE_VERSION: '1.2.4' }).status).toBe(1);
    expect(verify({ MYCO_GATE_LAUNCH_EXIT: '23' }).status).toBe(23);
    fs.writeFileSync(asset, fixture + '\n');
    expect(verify().status).not.toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toBe('verify\n');
    checksum();
    for (const text of ['', 'bad  myco-darwin-arm64\n', fs.readFileSync(manifest, 'utf8').repeat(2)]) {
      fs.writeFileSync(manifest, text);
      expect(verify().status).not.toBe(0);
      expect(fs.readFileSync(calls, 'utf8')).toBe('verify\n');
    }

  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

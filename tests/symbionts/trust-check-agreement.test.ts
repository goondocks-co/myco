/**
 * G7 trust-check cross-copy agreement test.
 *
 * The runtime pin trust check (G7) exists in two real implementations — the
 * TS contract (src/runtime/binary-resolution.ts, consumed by all TS sites via
 * delegation) and the shared shim module (bin/binary-resolution.cjs, consumed
 * by every bin/ entry point) — plus mirrors in agent plugin templates that
 * cannot import either. All copies must enforce the SAME mask (0o022) and the
 * SAME check shape (win32 short-circuit / uid-ownership / mode-mask).
 *
 * Copies covered:
 *   - src/runtime/binary-resolution.ts     (PIN_INSECURE_MODE_MASK — TS contract)
 *   - bin/binary-resolution.cjs             (PIN_INSECURE_MODE_MASK — shim module)
 *   - src/symbionts/templates/myco-run.cjs  (RUNTIME_COMMAND_INSECURE_MODE_MASK)
 *   - src/symbionts/templates/{cline,opencode,pi}/plugin.ts (RUNTIME_PIN_INSECURE_MODE_MASK)
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve('.');

const COPIES = [
  {
    label: 'src/runtime/binary-resolution.ts',
    file: 'packages/myco/src/runtime/binary-resolution.ts',
    maskName: 'PIN_INSECURE_MODE_MASK',
  },
  {
    label: 'bin/binary-resolution.cjs',
    file: 'packages/myco/bin/binary-resolution.cjs',
    maskName: 'PIN_INSECURE_MODE_MASK',
  },
  {
    label: 'src/symbionts/templates/myco-run.cjs',
    file: 'packages/myco/src/symbionts/templates/myco-run.cjs',
    maskName: 'RUNTIME_COMMAND_INSECURE_MODE_MASK',
  },
  {
    label: 'src/symbionts/templates/cline/plugin.ts',
    file: 'packages/myco/src/symbionts/templates/cline/plugin.ts',
    maskName: 'RUNTIME_PIN_INSECURE_MODE_MASK',
  },
  {
    label: 'src/symbionts/templates/opencode/plugin.ts',
    file: 'packages/myco/src/symbionts/templates/opencode/plugin.ts',
    maskName: 'RUNTIME_PIN_INSECURE_MODE_MASK',
  },
  {
    label: 'src/symbionts/templates/pi/plugin.ts',
    file: 'packages/myco/src/symbionts/templates/pi/plugin.ts',
    maskName: 'RUNTIME_PIN_INSECURE_MODE_MASK',
  },
] as const;

const MASK_VALUE = 0o022; // 18 decimal

describe('G7 trust-check cross-copy agreement', () => {
  for (const { label, file, maskName } of COPIES) {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');

    it(`${label}: mask constant is ${maskName} = 0o022`, () => {
      // The mask must appear as either octal literal 0o022 or decimal 18.
      const maskDeclaration = new RegExp(
        `${maskName}\\s*=\\s*(0o022|18)\\b`,
      );
      expect(maskDeclaration.test(src)).toBe(true);
    });

    it(`${label}: win32 is gated (skipped or short-circuited on win32)`, () => {
      // CJS files: `=== 'win32'` short-circuit return.
      // TS plugin files: `!== "win32"` guard around the POSIX check.
      // Both patterns correctly skip the POSIX uid/mode check on Windows.
      expect(src.includes("=== 'win32'") || src.includes('!== "win32"')).toBe(true);
    });

    it(`${label}: uid-ownership check is present`, () => {
      // All copies check stat.uid !== myUid (or equivalent).
      expect(/stat\.uid[^;]*myUid|myUid[^;]*stat\.uid/.test(src)).toBe(true);
    });

    it(`${label}: mode-mask check uses ${maskName}`, () => {
      // All copies apply the mask to stat.mode and check the result.
      expect(src).toContain(maskName);
      // The check: (stat.mode & 0o777) & MASK or mode & MASK
      const modeCheck = new RegExp(
        `(?:stat\\.mode\\s*&|mode\\s*&)\\s*(?:0o777\\s*\\)\\s*&\\s*)?${maskName}`,
      );
      expect(modeCheck.test(src)).toBe(true);
    });
  }

  it('all copies use the same mask value (0o022 = 18)', () => {
    // Cross-copy: extract the literal value from each file and assert agreement.
    const extracted: Array<{ label: string; value: number }> = [];
    for (const { label, file, maskName } of COPIES) {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      const match = src.match(new RegExp(`${maskName}\\s*=\\s*(0o[0-7]+|\\d+)`));
      expect(match, `${label}: could not find ${maskName} declaration`).toBeTruthy();
      const raw = match![1];
      const value = raw.startsWith('0o') ? parseInt(raw.slice(2), 8) : parseInt(raw, 10);
      extracted.push({ label, value });
    }
    for (const { label, value } of extracted) {
      expect(value, `${label}: mask value mismatch (expected ${MASK_VALUE}, got ${value})`).toBe(MASK_VALUE);
    }
  });
});

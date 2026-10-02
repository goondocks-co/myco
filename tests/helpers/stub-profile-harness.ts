import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHarnesses, locate, type DetectedHarness } from '@myco/runner/detect.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

export const PROFILE_STUB_HARNESS = 'claude-code';
export const PROFILE_STUB_BINARY = 'claude';
export const PROFILE_STUB_DETECTED = {
  detected: { id: PROFILE_STUB_HARNESS, installed: true, authenticated: true },
  resolvedIsStub: true,
};

export const STUB_PROFILE = {
  tier: 'default', model: 'sonnet', effort: 'medium', sources: { tier: 'task', model: 'default' },
} as const;

interface StubOptions {
  holdUntil?: string;
  ignoreTermination?: boolean;
  pidFile?: string;
  spawnedFile?: string;
  argumentsFile?: string;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** A profile-capable fake harness that answers a Claude Code stream and its login probe. */
export function stubProfileHarness(options: StubOptions = {}): { detected: DetectedHarness; resolvedIsStub: boolean } {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-stub-profile-')));
  const binary = join(dir, PROFILE_STUB_BINARY);
  const hold = options.holdUntil === undefined ? '' : [
    `waited=0`,
    `while [ ! -f ${quote(options.holdUntil)} ] && [ "$waited" -lt 1200 ]; do`,
    '  sleep 0.05',
    '  waited=$((waited + 1))',
    'done',
  ].join('\n');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    options.ignoreTermination === true ? "trap '' TERM" : '',
    options.argumentsFile === undefined ? '' : `printf '%s\\n' "$@" > ${quote(options.argumentsFile)}`,
    options.spawnedFile === undefined ? '' : `printf '%s\\n' "$$" >> ${quote(options.spawnedFile)}`,
    options.pidFile === undefined ? '' : `printf '%s\\n' "$$" > ${quote(options.pidFile)}`,
    hold,
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess_stub","model":"claude-sonnet-5-5"}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'`,
  ].join('\n');
  writeFileSync(binary, script, { mode: 0o755 });
  chmodSync(binary, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  return {
    detected: detectHarnesses([PROFILE_STUB_HARNESS])[0] ?? { id: PROFILE_STUB_HARNESS, installed: false, authenticated: false },
    resolvedIsStub: locate(PROFILE_STUB_BINARY) === binary,
  };
}

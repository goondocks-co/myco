import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarnesses, locate, type DetectedHarness } from '@myco/runner/detect.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

export const PROFILE_STUB_HARNESS = 'claude-code';
export const PROFILE_STUB_BINARY = 'claude';
export const PROFILE_STUB_DETECTED = {
  detected: { id: PROFILE_STUB_HARNESS, installed: true, authenticated: true },
  resolvedIsStub: true,
};

/** The models the stub lists when asked the way a worker lists Claude Code's: an alias with its resolution, and a dated id. */
export const STUB_LISTED_MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
] as const;

/** Answers a listing the way Claude Code does: the initialize request it was sent, under the id it carried, noting it in `listedFile` where one is named. */
const listingAnswer = (listedFile: string | undefined): string => [
  'case " $* " in *" --input-format "*)',
  listedFile === undefined ? '' : `  printf 'listed\\n' >> ${quote(listedFile)}`,
  '  IFS= read -r line',
  `  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')`,
  `  printf '%s%s%s\\n' '{"type":"control_response","response":{"subtype":"success","request_id":"' "$id" '","response":{"models":${JSON.stringify(STUB_LISTED_MODELS)}}}}'`,
  '  exit 0 ;;',
  'esac',
].join('\n');

export const STUB_PROFILE = {
  tier: 'default', model: 'sonnet', effort: 'medium', sources: { tier: 'task', model: 'default' },
} as const;

interface StubOptions {
  holdUntil?: string;
  ignoreTermination?: boolean;
  pidFile?: string;
  spawnedFile?: string;
  /** Where each listing of the stub's models is noted. */
  listedFile?: string;
  argumentsFile?: string;
  mcpReceipt?: string;
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
  const mcpRead = options.mcpReceipt === undefined ? '' : [
    'mcp_config=',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--mcp-config" ]; then shift; mcp_config="$1"; break; fi',
    '  shift',
    'done',
    `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./stub-profile-mcp.mjs', import.meta.url)))} "$mcp_config" ${quote(options.mcpReceipt)} || exit 1`,
  ].join('\n');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    listingAnswer(options.listedFile),
    options.ignoreTermination === true ? "trap '' TERM" : '',
    options.argumentsFile === undefined ? '' : `printf '%s\\n' "$@" > ${quote(options.argumentsFile)}`,
    options.spawnedFile === undefined ? '' : `printf '%s\\n' "$$" >> ${quote(options.spawnedFile)}`,
    options.pidFile === undefined ? '' : `printf '%s\\n' "$$" > ${quote(options.pidFile)}`,
    mcpRead,
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

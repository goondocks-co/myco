/**
 * Hook payload normalization layer.
 *
 * Each agent sends different field names in hook stdin (e.g., Claude Code uses
 * `session_id`, VS Code uses `sessionId`, Windsurf uses `trajectory_id`).
 * This module detects the active agent from the build-time generated hook
 * config (`hook-config.generated.ts` — no YAML or Zod on the hook hot path)
 * and maps the raw input to a canonical shape that all hooks can consume
 * uniformly.
 */

import { HOOK_CONFIG, type HookConfigEntry } from './hook-config.generated.js';
import { readSymbiontFlag } from './symbiont-flag.js';
import type { HookFieldPath } from '../symbionts/adapter.js';
import { getAtPath } from '../utils/dot-path.js';
import { normalizePromptKey } from '@goondocks/myco-shared/prompt-identity';

/** Canonical hook input with normalized field names. */
export interface NormalizedHookInput {
  /** Detected agent name from manifest (e.g., 'claude-code', 'codex', 'windsurf'). */
  agent: string;
  sessionId?: string;
  transcriptPath?: string;
  lastResponse?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** The harness's own key for this submission, at the field its manifest's `promptIdentity.hookKey` names; absent when the harness sent none. */
  promptKey?: string;
  /** The full raw input for any fields not covered by the mapping. */
  raw: Record<string, unknown>;
}

/** The agent of a hook no manifest was detected for: none. The hook refuses to capture it (`member/capture.ts`). */
export const NO_AGENT = '';

/** The facts normalization reads for one symbiont, from the generated hook config. */
interface HookSymbiont {
  name: string;
  hookFields: HookConfigEntry['hookFields'];
  promptKeyField?: string;
}

/** The manifest last resolved for one symbiont flag and one config entry. */
let cachedManifest: { name: string | undefined; entry: HookConfigEntry | undefined; manifest: HookSymbiont | null } | undefined;

/**
 * The symbiont driving this hook invocation: the one its command names (`--symbiont <name>`), which the installer
 * renders into every hook command it writes. Nothing else names one: a command that names none, or a harness no
 * manifest knows, is no symbiont's, and the hook refuses it (`member/capture.ts`).
 *
 * Resolved again when the command names a different symbiont or its config entry is a different object.
 */
function detectManifest(): HookSymbiont | null {
  const name = readSymbiontFlag(process.argv);
  const entry = name === undefined ? undefined : HOOK_CONFIG[name];
  if (cachedManifest && cachedManifest.name === name && cachedManifest.entry === entry) return cachedManifest.manifest;
  const manifest = entry === undefined ? null : { name: name!, hookFields: entry.hookFields, promptKeyField: entry.promptIdentity.hookKey };
  cachedManifest = { name, entry, manifest };
  return manifest;
}

/**
 * The session id a harness writes into its transcript path, for a payload that carries none: the first group of the
 * first of its manifest's `hookFields.sessionIdFromTranscriptPath` patterns that matches the path (forward slashes).
 */
function deriveSessionIdFromTranscriptPath(
  manifest: HookSymbiont,
  transcriptPath: string | undefined,
): string | undefined {
  if (!transcriptPath) return undefined;

  const normalized = transcriptPath.replace(/\\/g, '/');
  for (const pattern of manifest.hookFields.sessionIdFromTranscriptPath ?? []) {
    const match = new RegExp(pattern).exec(normalized);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function getFirstAtPath(input: Record<string, unknown>, field: HookFieldPath): unknown {
  const paths = Array.isArray(field) ? field : [field];
  for (const candidate of paths) {
    const value = getAtPath(input, candidate);
    // Treat blank/nullish as absent so a present-but-empty primary field (e.g. a
    // host that emits `conversation_id: ''`) doesn't shadow a populated alias
    // later in the list. Non-string payloads (tool_input objects) pass through.
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function normalizeHookInput(input: Record<string, unknown>): NormalizedHookInput {
  const manifest = detectManifest();
  if (manifest === null) return { agent: NO_AGENT, raw: input };
  const fields = manifest.hookFields;
  const transcriptPath = getFirstAtPath(input, fields.transcriptPath) as string | undefined;

  // Resolve session ID: try the mapped field, then explicit transcript-path parsing
  // for known symbionts, then env var fallback, then MYCO_SESSION_ID.
  // Do NOT fabricate synthetic session IDs for symbiont hooks with missing payloads.
  const sessionIdFromInput = getFirstAtPath(input, fields.sessionId) as string | undefined;
  const sessionIdFromTranscriptPath = deriveSessionIdFromTranscriptPath(manifest, transcriptPath);
  const sessionIdFromEnv = fields.sessionIdEnv ? process.env[fields.sessionIdEnv] : undefined;
  const sessionId = sessionIdFromInput
    ?? sessionIdFromTranscriptPath
    ?? sessionIdFromEnv
    ?? process.env.MYCO_SESSION_ID;
  const promptKey = manifest.promptKeyField === undefined ? undefined : normalizePromptKey(getAtPath(input, manifest.promptKeyField));

  return {
    agent: manifest.name,
    sessionId,
    transcriptPath,
    lastResponse: getFirstAtPath(input, fields.lastResponse) as string | undefined,
    prompt: getFirstAtPath(input, fields.prompt) as string | undefined,
    toolName: getFirstAtPath(input, fields.toolName) as string | undefined,
    toolInput: getFirstAtPath(input, fields.toolInput),
    toolOutput: getFirstAtPath(input, fields.toolOutput),
    ...(promptKey === undefined ? {} : { promptKey }),
    raw: input,
  };
}

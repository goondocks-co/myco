/**
 * Hook payload normalization layer.
 *
 * Each agent sends different field names in hook stdin (e.g., Claude Code uses
 * `session_id`, VS Code uses `sessionId`, Windsurf uses `trajectory_id`).
 * This module detects the active agent, loads its manifest, and maps the
 * raw input to a canonical shape that all hooks can consume uniformly.
 */

import { loadManifests } from '../symbionts/detect.js';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';

/** Default field mappings when no agent manifest is detected (Claude Code conventions). */
const DEFAULT_HOOK_FIELDS = {
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  lastResponse: 'last_assistant_message',
  prompt: 'prompt',
  toolName: 'tool_name',
  toolInput: 'tool_input',
  toolOutput: 'tool_output',
} as const;

/** Canonical hook input with normalized field names. */
export interface NormalizedHookInput {
  sessionId: string;
  transcriptPath?: string;
  lastResponse?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** The full raw input for any fields not covered by the mapping. */
  raw: Record<string, unknown>;
}

/** Cached manifest for the detected agent — resolved once per process. */
let cachedManifest: SymbiontManifest | null | undefined;

function detectManifest(): SymbiontManifest | null {
  if (cachedManifest !== undefined) return cachedManifest;

  const manifests = loadManifests();

  // Try env-var detection: check pluginRootEnvVar for each manifest
  for (const m of manifests) {
    if (process.env[m.pluginRootEnvVar]) {
      cachedManifest = m;
      return m;
    }
  }

  // Fallback: check sessionIdEnv (e.g., GEMINI_SESSION_ID)
  for (const m of manifests) {
    if (m.hookFields.sessionIdEnv && process.env[m.hookFields.sessionIdEnv]) {
      cachedManifest = m;
      return m;
    }
  }

  cachedManifest = null;
  return null;
}

/**
 * Resolve a potentially nested field path from the input.
 * Supports dot notation for nested objects (e.g., "tool_info.command_line").
 */
function resolveField(input: Record<string, unknown>, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Normalize a raw hook input using the active agent's manifest field mappings.
 * Falls back to Claude Code field names if no agent is detected.
 */
export function normalizeHookInput(input: Record<string, unknown>): NormalizedHookInput {
  const manifest = detectManifest();
  const fields = manifest?.hookFields ?? DEFAULT_HOOK_FIELDS;

  // Resolve session ID: try the mapped field, then env var fallback, then MYCO_SESSION_ID
  const sessionIdFromInput = resolveField(input, fields.sessionId) as string | undefined;
  const sessionIdFromEnv = 'sessionIdEnv' in fields && fields.sessionIdEnv
    ? process.env[fields.sessionIdEnv]
    : undefined;
  const sessionId = sessionIdFromInput
    ?? sessionIdFromEnv
    ?? process.env.MYCO_SESSION_ID
    ?? `s-${Date.now()}`;

  return {
    sessionId,
    transcriptPath: resolveField(input, fields.transcriptPath) as string | undefined,
    lastResponse: resolveField(input, fields.lastResponse) as string | undefined,
    prompt: resolveField(input, fields.prompt) as string | undefined,
    toolName: resolveField(input, fields.toolName) as string | undefined,
    toolInput: resolveField(input, fields.toolInput),
    toolOutput: resolveField(input, fields.toolOutput),
    raw: input,
  };
}

/** Reset cached manifest — exposed for testing only. */
export function _resetManifestCache(): void {
  cachedManifest = undefined;
}

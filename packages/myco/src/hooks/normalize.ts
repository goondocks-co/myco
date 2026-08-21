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
import type { HookFieldPath } from '../symbionts/adapter.js';
import { getAtPath } from '../utils/dot-path.js';
import path from 'node:path';

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
  /** Detected agent name from manifest (e.g., 'claude-code', 'codex', 'windsurf'). */
  agent: string;
  sessionId?: string;
  transcriptPath?: string;
  lastResponse?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** The full raw input for any fields not covered by the mapping. */
  raw: Record<string, unknown>;
}

/** Default agent name when no manifest is detected. */
const DEFAULT_AGENT_NAME = 'claude-code';

/** The identity facts detection reads for one symbiont, from the generated hook config. */
interface HookSymbiont {
  name: string;
  pluginRootEnvVar: HookConfigEntry['pluginRootEnvVar'];
  configDir: HookConfigEntry['configDir'];
  hookFields: HookConfigEntry['hookFields'];
}

/** Every symbiont the generated hook config knows, in its (manifest-name) order. */
function hookSymbionts(): HookSymbiont[] {
  return Object.entries(HOOK_CONFIG).map(([name, entry]) => ({
    name,
    pluginRootEnvVar: entry.pluginRootEnvVar,
    configDir: entry.configDir,
    hookFields: entry.hookFields,
  }));
}

/** Cached identity for the detected agent — resolved once per process. */
let cachedManifest: HookSymbiont | null | undefined;

/**
 * Parse `--symbiont <name>` from process argv.
 *
 * The hook command line rendered by the installer for every symbiont's
 * hooks.json looks like:
 *
 *     node .agents/myco-run.cjs hook session-start --symbiont codex
 *
 * `.agents/myco-run.cjs` resolves the myco binary via
 * `.myco/runtime.command` and execs it with all argv passed through, so
 * by the time the hook handler module loads, `process.argv` contains
 * the flag. This is the installer's explicit declaration of which
 * symbiont owns this invocation — strictly more reliable than any
 * runtime heuristic.
 *
 * Supports both `--symbiont codex` (two args) and `--symbiont=codex`
 * (one arg) to be forgiving about shell quoting on Windows.
 */
export function readSymbiontFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--symbiont') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) return next;
    } else if (arg.startsWith('--symbiont=')) {
      return arg.slice('--symbiont='.length);
    }
  }
  return undefined;
}

/**
 * Detect which symbiont is driving this hook invocation.
 *
 * Detection strategies in order:
 *   1. **Primary** — `--symbiont <name>` argv flag rendered into each
 *      agent's hooks.json at install time. Dead simple and unambiguous:
 *      the installer knows which agent it's writing into, so we bake
 *      the identity into the hook command itself.
 *   2. `pluginRootEnvVar` (e.g., `CLAUDE_PLUGIN_ROOT`) — set natively by
 *      agents that cooperate with a plugin system. Fallback for older
 *      installs that predate the argv flag.
 *   3. `sessionIdEnv` fallback (e.g., `GEMINI_SESSION_ID`) — set by agents
 *      that expose the session via env var rather than payload field.
 *   4. Payload-driven heuristic: match the event's `transcript_path` /
 *      `cwd` against each manifest's `configDir`. Safety net for pre-
 *      flag installations that have somehow also lost their env-var
 *      signal. Generic — works for every manifest without per-agent
 *      branching.
 *
 * The cache is per-process, which is fine: each hook invocation is a
 * short-lived Node process. `input` is optional so callers that just
 * want env-based detection (e.g., at module import time) still work.
 */
function detectManifest(input?: Record<string, unknown>): HookSymbiont | null {
  if (cachedManifest !== undefined) return cachedManifest;

  const manifests = hookSymbionts();

  // 1) Primary: explicit --symbiont flag from the installer-rendered
  //    hook command. This is the source of truth when present.
  const flagName = readSymbiontFlag(process.argv);
  if (flagName) {
    const m = manifests.find((x) => x.name === flagName);
    if (m) {
      cachedManifest = m;
      return m;
    }
    // Flag specified an unknown manifest — fall through to heuristics
    // rather than guessing. Logging happens at the handler level.
  }

  // 2) Env-var detection: check pluginRootEnvVar for each manifest.
  for (const m of manifests) {
    if (process.env[m.pluginRootEnvVar]) {
      cachedManifest = m;
      return m;
    }
  }

  // 3) sessionIdEnv fallback (e.g., GEMINI_SESSION_ID).
  for (const m of manifests) {
    if (m.hookFields.sessionIdEnv && process.env[m.hookFields.sessionIdEnv]) {
      cachedManifest = m;
      return m;
    }
  }

  // 4) Payload-driven heuristic: match configDir against transcript_path
  //    / cwd. Kept as a safety net for pre-flag installations. Preferred
  //    signals above always win when they're available.
  if (input) {
    const candidates: string[] = [];
    const tp = input.transcript_path;
    const cwd = input.cwd;
    if (typeof tp === 'string' && tp.length > 0) candidates.push(tp);
    if (typeof cwd === 'string' && cwd.length > 0) candidates.push(cwd);
    for (const m of manifests) {
      const marker = `/${m.configDir}/`;
      if (candidates.some((c) => c.includes(marker))) {
        cachedManifest = m;
        return m;
      }
    }
  }

  cachedManifest = null;
  return null;
}

/**
 * Normalize a raw hook input using the active agent's manifest field mappings.
 * Falls back to Claude Code field names if no agent is detected.
 */
function deriveSessionIdFromTranscriptPath(
  manifest: HookSymbiont | null,
  transcriptPath: string | undefined,
): string | undefined {
  if (!manifest || !transcriptPath) return undefined;

  if (manifest.name === 'cursor') {
    const normalized = transcriptPath.replace(/\\/g, '/');
    const basename = path.posix.basename(normalized);
    const jsonlMatch = normalized.match(/\/agent-transcripts\/([^/]+)\/\1\.jsonl$/);
    if (jsonlMatch) return jsonlMatch[1];

    const textMatch = basename.match(/^([^.]+)\.txt$/);
    if (textMatch) return textMatch[1];
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
  const manifest = detectManifest(input);
  const fields = manifest?.hookFields ?? DEFAULT_HOOK_FIELDS;
  const transcriptPath = getFirstAtPath(input, fields.transcriptPath) as string | undefined;

  // Resolve session ID: try the mapped field, then explicit transcript-path parsing
  // for known symbionts, then env var fallback, then MYCO_SESSION_ID.
  // Do NOT fabricate synthetic session IDs for symbiont hooks with missing payloads.
  const sessionIdFromInput = getFirstAtPath(input, fields.sessionId) as string | undefined;
  const sessionIdFromTranscriptPath = deriveSessionIdFromTranscriptPath(manifest, transcriptPath);
  const sessionIdFromEnv = 'sessionIdEnv' in fields && fields.sessionIdEnv
    ? process.env[fields.sessionIdEnv]
    : undefined;
  const sessionId = sessionIdFromInput
    ?? sessionIdFromTranscriptPath
    ?? sessionIdFromEnv
    ?? process.env.MYCO_SESSION_ID;

  return {
    agent: manifest?.name ?? DEFAULT_AGENT_NAME,
    sessionId,
    transcriptPath,
    lastResponse: getFirstAtPath(input, fields.lastResponse) as string | undefined,
    prompt: getFirstAtPath(input, fields.prompt) as string | undefined,
    toolName: getFirstAtPath(input, fields.toolName) as string | undefined,
    toolInput: getFirstAtPath(input, fields.toolInput),
    toolOutput: getFirstAtPath(input, fields.toolOutput),
    raw: input,
  };
}

/** Reset cached manifest — exposed for testing only. */
export function _resetManifestCache(): void {
  cachedManifest = undefined;
}

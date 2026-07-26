import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUNDLED_MANIFESTS } from './manifests.generated.js';
import type { TranscriptDiscovery } from './manifest-schema.js';

/**
 * Manifest-driven transcript location.
 *
 * Every agent's on-disk layout used to live as a hand-rolled `findTranscript`
 * in its adapter, which put agent-specific paths in code and gave enumeration
 * no home at all. Both directions now derive from one `transcriptDiscovery`
 * template set in the manifest, so a layout change is a manifest edit and the
 * lookup and enumeration paths cannot disagree about where transcripts live.
 */

const SESSION_ID_TOKEN = '{sessionId}';

/**
 * This agent's declared layout, or undefined when it declares none — which
 * for a plugin-reported agent (pi, opencode, cline) is correct rather than a
 * gap: their plugin posts complete events and leaves no transcript to mine.
 *
 * Reads the build-time manifest bundle, the same source
 * `systemEnvelopePrefixes` uses, so adapter behavior and audit tooling agree
 * by construction.
 */
export function manifestTranscriptDiscovery(agent: string): TranscriptDiscovery | undefined {
  return BUNDLED_MANIFESTS.find((m) => m.name === agent)?.capture?.transcriptDiscovery;
}

/** Locate a transcript using the agent's manifest-declared layout. */
export function findTranscriptFor(agent: string, sessionId: string): string | null {
  return resolveTranscriptPath(manifestTranscriptDiscovery(agent), sessionId);
}

/** Expand `~` and `$VAR` / `${VAR}` forms against the current environment. */
export function expandRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const withEnv = root.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (whole, name: string) => env[name] ?? whole);
  if (withEnv === '~') return os.homedir();
  if (withEnv.startsWith('~/')) return path.join(os.homedir(), withEnv.slice(2));
  return withEnv;
}

/**
 * One path segment of a template, compiled to a matcher.
 *
 * `capturesSessionId` drives enumeration: those segments yield the id rather
 * than merely constraining the walk.
 */
interface SegmentMatcher {
  test(name: string): boolean;
  extractSessionId(name: string): string | null;
  capturesSessionId: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one template segment.
 *
 * `sessionId` is the literal id for lookup, or null for enumeration — the only
 * difference between the two directions, which is why they share this code.
 */
function compileSegment(
  segment: string,
  sessionId: string | null,
  sessionIdPattern: string,
): SegmentMatcher {
  const hasSessionId = segment.includes(SESSION_ID_TOKEN);

  if (hasSessionId && sessionId !== null) {
    const literal = segment.replaceAll(SESSION_ID_TOKEN, sessionId);
    return {
      test: (name) => wildcardRegex(literal).test(name),
      extractSessionId: () => sessionId,
      capturesSessionId: false,
    };
  }

  if (hasSessionId) {
    // Enumeration: `*` stays greedy and backtracks until the declared id shape
    // matches. With a constrained `sessionIdPattern` that lands on the real
    // boundary; with the default `[^/]+` the template must not be ambiguous.
    const pattern = segment
      .split(SESSION_ID_TOKEN)
      .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
      .join(`(?<sessionId>${sessionIdPattern})`);
    const regex = new RegExp(`^${pattern}$`);
    return {
      test: (name) => regex.test(name),
      extractSessionId: (name) => regex.exec(name)?.groups?.sessionId ?? null,
      capturesSessionId: true,
    };
  }

  const regex = wildcardRegex(segment);
  return { test: (name) => regex.test(name), extractSessionId: () => null, capturesSessionId: false };
}

function wildcardRegex(segment: string): RegExp {
  return new RegExp(`^${segment.split('*').map(escapeRegex).join('[^/]*')}$`);
}

export interface DiscoveredTranscript {
  sessionId: string;
  filePath: string;
}

/**
 * Walk `root` against compiled segments. Intermediate segments must be
 * directories and the final segment a file, so a directory sharing a
 * transcript's name is never mistaken for one.
 */
function walk(
  dir: string,
  segments: SegmentMatcher[],
  index: number,
  sessionIdSoFar: string | null,
  out: DiscoveredTranscript[],
  limit: number,
): void {
  if (out.length >= limit) return;

  const matcher = segments[index];
  if (!matcher) return;
  const isLast = index === segments.length - 1;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root or intermediate directory absent — not an error
  }

  for (const entry of entries) {
    if (out.length >= limit) return;
    if (!matcher.test(entry.name)) continue;

    const captured = matcher.capturesSessionId ? matcher.extractSessionId(entry.name) : sessionIdSoFar;

    if (isLast) {
      if (!entry.isFile()) continue;
      if (!captured) continue;
      out.push({ sessionId: captured, filePath: path.join(dir, entry.name) });
      continue;
    }

    if (!entry.isDirectory()) continue;
    walk(path.join(dir, entry.name), segments, index + 1, captured, out, limit);
  }
}

const DEFAULT_SESSION_ID_PATTERN = '[^/]+';

function patternSegments(
  pattern: string,
  sessionId: string | null,
  sessionIdPattern: string,
): SegmentMatcher[] {
  return pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => compileSegment(segment, sessionId, sessionIdPattern));
}

/**
 * Locate the transcript for a known session id. Patterns are tried in
 * declaration order and the first existing file wins, which is how agents
 * that changed layout across versions (Cursor's `.txt` then `.jsonl`) keep
 * resolving for both.
 */
export function resolveTranscriptPath(
  discovery: TranscriptDiscovery | undefined,
  sessionId: string,
): string | null {
  if (!discovery || !sessionId) return null;

  const idPattern = discovery.sessionIdPattern ?? DEFAULT_SESSION_ID_PATTERN;
  for (const pattern of discovery.patterns) {
    for (const root of discovery.roots) {
      const found: DiscoveredTranscript[] = [];
      walk(expandRoot(root), patternSegments(pattern, sessionId, idPattern), 0, sessionId, found, 1);
      if (found[0]) return found[0].filePath;
    }
  }
  return null;
}

/**
 * Enumerate every transcript on disk for this agent — the direction hooks
 * cannot provide, and the only way to find sessions that were never captured
 * at all. `limit` bounds the walk so one agent with a deep history cannot
 * dominate a run; callers report when it was hit rather than silently
 * treating a truncated list as complete.
 */
export function enumerateTranscripts(
  discovery: TranscriptDiscovery | undefined,
  limit = 5000,
): DiscoveredTranscript[] {
  if (!discovery) return [];

  const idPattern = discovery.sessionIdPattern ?? DEFAULT_SESSION_ID_PATTERN;
  const seen = new Map<string, DiscoveredTranscript>();
  for (const pattern of discovery.patterns) {
    for (const root of discovery.roots) {
      const found: DiscoveredTranscript[] = [];
      walk(expandRoot(root), patternSegments(pattern, null, idPattern), 0, null, found, limit);
      // Earlier patterns win, matching resolveTranscriptPath's precedence.
      for (const item of found) if (!seen.has(item.sessionId)) seen.set(item.sessionId, item);
    }
  }
  return [...seen.values()];
}

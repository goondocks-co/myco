import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMycoHome } from '../paths/home.js';
import { BUNDLED_MANIFESTS } from './manifests.generated.js';
import type { TranscriptDiscovery } from './manifest-schema.js';

/**
 * Manifest-driven transcript location.
 *
 * Lookup and enumeration both derive from one `transcriptDiscovery` template
 * set, so a layout change is a manifest edit and the two directions resolve
 * against the same declaration.
 */

const SESSION_ID_TOKEN = '{sessionId}';

/**
 * This agent's declared layout, or undefined when it declares none.
 *
 * Reads the build-time manifest bundle, the same source
 * `systemEnvelopePrefixes` uses, so adapter behavior and audit tooling agree
 * by construction.
 */
export function manifestTranscriptDiscovery(agent: string): TranscriptDiscovery | undefined {
  return BUNDLED_MANIFESTS.find((m) => m.name === agent)?.capture?.transcriptDiscovery;
}

/** Locate a transcript using the agent's manifest-declared layout. */
export function findTranscriptFor(agent: string, sessionId: string, mycoHome?: string): string | null {
  return resolveTranscriptPath(manifestTranscriptDiscovery(agent), sessionId, mycoHome);
}

/**
 * Prefix naming the member's state root. A root that begins with it resolves
 * through `resolveMycoHome`, never through a literal `${MYCO_HOME}`, which
 * expands to itself when the variable is unset.
 *
 * The resolver reads the environment. A plugin that writes under a project's
 * `runtime.home` pin therefore passes the home it resolved to the binary it
 * runs, so the process doing the discovery and the process that wrote the
 * transcript name one directory.
 */
const MEMBER_HOME_PREFIX = '@memberHome';

/**
 * Expand `@memberHome`, `~` and `$VAR` / `${VAR}` forms.
 *
 * `@memberHome` is the home the caller is working under — passed in by a
 * caller that has already resolved one (a hook under a project pin), else the
 * member's own resolver — so discovery and the runtime that wrote the
 * transcript name one directory.
 */
export function expandRoot(root: string, env: NodeJS.ProcessEnv = process.env, mycoHome?: string): string {
  if (root === MEMBER_HOME_PREFIX || root.startsWith(`${MEMBER_HOME_PREFIX}/`)) {
    const home = mycoHome ?? resolveMycoHome({ env, homeDir: env.HOME && env.HOME.length > 0 ? env.HOME : undefined });
    const rest = root.slice(MEMBER_HOME_PREFIX.length).replace(/^\//, '');
    return rest === '' ? home : path.join(home, rest);
  }
  return expandShellRoot(root, env);
}

function expandShellRoot(root: string, env: NodeJS.ProcessEnv): string {
  const withEnv = root.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (whole, name: string) => env[name] ?? whole);
  // `~` must expand against THIS env, not a process-start-cached homedir, so
  // a caller (a test, a sandboxed subprocess) can scope discovery to a
  // sandbox HOME by setting the env var alone. os.homedir() only remains a
  // fallback for the (unusual) case HOME isn't set.
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir();
  if (withEnv === '~') return home;
  if (withEnv.startsWith('~/')) return path.join(home, withEnv.slice(2));
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

/** Member-owned stores keep identical session ids separate by destination. */
function enumerationKey(discovery: TranscriptDiscovery, root: string, item: DiscoveredTranscript): string {
  if (discovery.retention === 'member') {
    const parts = path.relative(root, item.filePath).split(path.sep);
    if (parts.length >= 4 && /^[0-9a-f]{16}$/.test(parts[0] ?? '') && parts[1]) {
      return JSON.stringify(['member', parts[0], parts[1], item.sessionId]);
    }
  }
  return JSON.stringify(['legacy', item.sessionId]);
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
  strictErrors = false,
): void {
  if (out.length >= limit) return;

  const matcher = segments[index];
  if (!matcher) return;
  const isLast = index === segments.length - 1;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (strictErrors && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    walk(path.join(dir, entry.name), segments, index + 1, captured, out, limit, strictErrors);
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
  mycoHome?: string,
): string | null {
  if (!discovery || !sessionId) return null;

  const idPattern = discovery.sessionIdPattern ?? DEFAULT_SESSION_ID_PATTERN;
  for (const pattern of discovery.patterns) {
    for (const root of discovery.roots) {
      const found: DiscoveredTranscript[] = [];
      walk(expandRoot(root, process.env, mycoHome), patternSegments(pattern, sessionId, idPattern), 0, sessionId, found, 1);
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
  mycoHome?: string,
): DiscoveredTranscript[] {
  if (!discovery) return [];

  const idPattern = discovery.sessionIdPattern ?? DEFAULT_SESSION_ID_PATTERN;
  const seen = new Map<string, DiscoveredTranscript>();
  for (const pattern of discovery.patterns) {
    for (const root of discovery.roots) {
      // One budget shared across every (pattern, root) pair, so the returned
      // count never exceeds `limit` and `length >= limit` means truncation.
      const remaining = limit - seen.size;
      if (remaining <= 0) return [...seen.values()];

      const expanded = expandRoot(root, process.env, mycoHome);
      const found: DiscoveredTranscript[] = [];
      walk(expanded, patternSegments(pattern, null, idPattern), 0, null, found, remaining);
      // Earlier patterns win, matching resolveTranscriptPath's precedence.
      for (const item of found) {
        const key = enumerationKey(discovery, expanded, item);
        if (!seen.has(key)) seen.set(key, item);
      }
    }
  }
  return [...seen.values()];
}

/**
 * The session id this agent's transcript layout names for a file, or null
 * when the path sits under none of the declared roots or matches none of the
 * declared patterns. The segments are the ones enumeration compiles, so the
 * id is the one enumeration yields for the same file.
 */
export function sessionIdFromTranscriptPath(
  discovery: TranscriptDiscovery | undefined,
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  mycoHome?: string,
): string | null {
  if (!discovery) return null;
  const idPattern = discovery.sessionIdPattern ?? DEFAULT_SESSION_ID_PATTERN;
  for (const pattern of discovery.patterns) {
    for (const root of discovery.roots) {
      const relative = path.relative(expandRoot(root, env, mycoHome), filePath);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const names = relative.split(path.sep);
      const segments = patternSegments(pattern, null, idPattern);
      if (names.length !== segments.length) continue;
      let captured: string | null = null;
      let matched = true;
      for (let i = 0; i < names.length; i++) {
        if (!segments[i].test(names[i])) { matched = false; break; }
        if (segments[i].capturesSessionId) captured = segments[i].extractSessionId(names[i]);
      }
      if (matched && captured) return captured;
    }
  }
  return null;
}

/**
 * The session id this agent's declared id shape finds at the end of a stored
 * id, or null when the agent declares no shape of its own or the id does not
 * end in one. A store that kept a file's whole name as the id (Pi's
 * `<timestamp>_<uuid>`) yields the id the layout names.
 */
export function sessionIdFromStoredId(discovery: TranscriptDiscovery | undefined, storedId: string): string | null {
  if (!discovery?.sessionIdPattern) return null;
  const match = new RegExp(`(?:^|[^0-9A-Za-z])(${discovery.sessionIdPattern})$`).exec(storedId);
  return match?.[1] ?? null;
}

/** Enumerate session records at one absolute layout, surfacing unreadable directories. */
export function enumerateSessionRecords(location: string, sessionIdPattern = DEFAULT_SESSION_ID_PATTERN): DiscoveredTranscript[] {
  const found: DiscoveredTranscript[] = [];
  const absolute = path.resolve(location);
  const volume = path.parse(absolute).root;
  const segments = absolute.slice(volume.length).split(path.sep);
  const firstPattern = segments.findIndex((segment) => segment.includes('*') || segment.includes(SESSION_ID_TOKEN));
  if (firstPattern < 0) return found;
  const root = path.join(volume, ...segments.slice(0, firstPattern));
  try { if (!fs.lstatSync(root).isDirectory()) return found; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw error;
  }
  walk(root, patternSegments(segments.slice(firstPattern).join('/'), null, sessionIdPattern), 0, null, found, Infinity, true);
  return found;
}

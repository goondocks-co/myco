import { describe, it, expect } from 'bun:test';

import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { SymbiontRegistry } from '@myco/symbionts/registry.js';

/**
 * Gates on the manifest declarations themselves.
 *
 * `transcript-discovery.test.ts` proves the resolver works against synthetic
 * layouts; these assert the shipped manifests actually declare the layouts
 * that matter, so a symbiont cannot lose disk-side discovery silently.
 */

const registry = new SymbiontRegistry();
const manifests = [...BUNDLED_MANIFESTS];

/** Transcript mining happens exactly when an adapter is registered. */
function minesTranscripts(name: string): boolean {
  return registry.getAdapter(name) !== undefined;
}

describe('manifest transcript discovery', () => {
  it('declares discovery for every symbiont whose transcripts Myco mines', () => {
    const missing = manifests
      .filter((m) => minesTranscripts(m.name))
      .filter((m) => !m.capture?.transcriptDiscovery)
      .map((m) => m.name);

    expect(missing).toEqual([]);
  });

  it('declares no discovery for plugin-reported symbionts, which have no transcript to mine', () => {
    // pi, opencode and cline post complete events from an in-agent plugin;
    // a NULL transcript_path for them is correct, not a capture defect.
    const spurious = manifests
      .filter((m) => !minesTranscripts(m.name))
      .filter((m) => m.capture?.transcriptDiscovery)
      .map((m) => m.name);

    expect(spurious).toEqual([]);
  });

  it('constrains the session id wherever a wildcard shares its path segment', () => {
    // `rollout-*-{sessionId}.jsonl` cannot be split correctly by any greediness
    // rule when both halves are dash-delimited — the id's shape has to be
    // declared. A `*` in a *different* segment (`*/{sessionId}.jsonl`) is
    // unambiguous, since `/` already bounds the match.
    const ambiguous: string[] = [];
    for (const manifest of manifests) {
      const discovery = manifest.capture?.transcriptDiscovery;
      if (!discovery || discovery.sessionIdPattern) continue;
      for (const pattern of discovery.patterns) {
        const hazardous = pattern
          .split('/')
          .some((segment) => segment.includes('{sessionId}') && segment.includes('*'));
        if (hazardous) ambiguous.push(`${manifest.name}: ${pattern}`);
      }
    }
    expect(ambiguous).toEqual([]);
  });

  it('keeps every declared root anchored to a home or environment path', () => {
    // A bare relative root would resolve against the daemon's cwd, which
    // varies (MCP children run with cwd=/).
    const unanchored: string[] = [];
    for (const manifest of manifests) {
      for (const root of manifest.capture?.transcriptDiscovery?.roots ?? []) {
        if (!root.startsWith('~') && !root.startsWith('/') && !root.startsWith('$')) {
          unanchored.push(`${manifest.name}: ${root}`);
        }
      }
    }
    expect(unanchored).toEqual([]);
  });

  it('preserves antigravity surface precedence: cli, then desktop, then ide', () => {
    const roots = manifests.find((m) => m.name === 'antigravity')?.capture?.transcriptDiscovery?.roots;
    expect(roots).toEqual([
      '~/.gemini/antigravity-cli',
      '~/.gemini/antigravity',
      '~/.gemini/antigravity-ide',
    ]);
  });

  it('keeps cursor resolving its legacy .txt layout ahead of the nested .jsonl one', () => {
    const patterns = manifests.find((m) => m.name === 'cursor')?.capture?.transcriptDiscovery?.patterns ?? [];
    expect(patterns[0]).toContain('.txt');
    expect(patterns[1]).toContain('.jsonl');
  });

  it('gives copilot a transcript layout — it was long assumed to have none', () => {
    const discovery = manifests.find((m) => m.name === 'copilot')?.capture?.transcriptDiscovery;
    expect(discovery?.roots).toEqual(['~/.copilot/session-state']);
    expect(discovery?.patterns).toEqual(['{sessionId}/events.jsonl']);
  });
});

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

  it('declares who prunes every store it discovers, so nothing deletes a harness\'s own history by default', () => {
    // The default is `harness`: a store Myco did not write is the user's own
    // history and the member never deletes it. Only an agent whose plugin
    // writes the transcript declares `member`, and that declaration is what
    // the pruner's safety gate reads.
    const undeclared = manifests
      .filter((m) => m.capture?.transcriptDiscovery)
      .filter((m) => m.capture?.transcriptDiscovery?.retention === undefined)
      .map((m) => m.name);

    expect(undeclared).toEqual([]);
  });

  it('declares a member-written store only where the agent keeps no append-only transcript of its own', () => {
    // opencode fans a session out across one JSON file per message and per
    // part; cline rewrites two whole documents in place. Neither carries a
    // byte offset a delta could be shipped against, so their plugin writes a
    // transcript and the member ages it. Every other agent's store is its own.
    const memberWritten = manifests
      .filter((m) => m.capture?.transcriptDiscovery?.retention === 'member')
      .map((m) => m.name)
      .sort();

    expect(memberWritten).toEqual(['cline', 'opencode']);
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
        // `@memberHome` resolves through the member's own home resolver, which
        // is the one anchor an environment spelling cannot express: the home is
        // a `runtime.home` pin first and `$MYCO_HOME` only after.
        if (root.startsWith('@memberHome')) continue;
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

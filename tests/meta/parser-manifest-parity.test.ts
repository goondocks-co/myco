/**
 * The server's per-agent parser facts, held equal to the agent's own manifest.
 *
 * `myco-server` does not depend on `packages/myco`, so a parser declares what
 * its agent's transcript carries rather than importing it. That is a copy, and
 * a copy that nothing checks drifts: a plan tag the member scans but the parse
 * does not would go underived, and one the parse invents would produce plans no
 * member ever sends. Cross-package imports live in `tests/meta/`, so this is
 * where the two are compared.
 */
import { describe, expect, it } from 'bun:test';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';

describe('parser facts against the agent manifests', () => {
  it('names an agent the manifests declare, so no parser is keyed to a name nothing produces', () => {
    for (const agent of Object.keys(PARSERS)) {
      expect({ agent, declared: HOOK_CONFIG[agent] !== undefined }).toEqual({ agent, declared: true });
    }
  });

  it('scans exactly the plan tags its agent declares', () => {
    for (const [agent, parser] of Object.entries(PARSERS)) {
      const declared = [...(HOOK_CONFIG[agent]?.planTags ?? [])].sort();
      expect({ agent, tags: [...parser.planTags].sort() }).toEqual({ agent, tags: declared });
    }
  });

  /**
   * The server reproduces the member's ownership rule rather than importing it,
   * so the declaration it reproduces has to be the manifest's. A parser that
   * named a different field would attribute a continued transcript's turns to
   * the wrong session, and a parser that declared none for an agent that
   * continues would derive its predecessor's prompts into the successor.
   */
  it('stitches a continued transcript on exactly the field its agent declares', () => {
    for (const [agent, parser] of Object.entries(PARSERS)) {
      const declared = HOOK_CONFIG[agent]?.sessionContinuation;
      expect({ agent, path: parser.continuation?.parentSessionIdPath ?? null })
        .toEqual({ agent, path: declared?.parentSessionIdPath ?? null });
      const markers = [...(declared?.markers ?? [])].map((m) => m.recordFlagPath).filter((p): p is string => typeof p === 'string').sort();
      expect({ agent, markers: [...(parser.continuation?.markerPaths ?? [])].sort() }).toEqual({ agent, markers });
    }
  });
});

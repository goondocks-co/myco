/**
 * API handlers for digest health and manual triggering.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DigestCycleResult } from '../digest.js';
import { readLastRecord } from '../trace.js';

// --- POST /api/pipeline/digest/force ---

export function handleForceDigest(
  setForceDigest: () => void,
): (req: RouteRequest) => Promise<RouteResponse> {
  return async () => {
    setForceDigest();
    return {
      body: {
        status: 'queued',
        message: 'Digest will run on next pipeline tick (upstream must be clear)',
      },
    };
  };
}

// --- GET /api/pipeline/digest-health ---

interface DigestHealthDeps {
  vaultDir: string;
  pipeline: { newSubstrateSinceLastDigest: () => number };
  minNotesForCycle: number;
  metabolismState: () => string;
  digestReady: () => boolean;
  cycleInProgress: () => boolean;
}

/** Read the `generated` timestamp from an extract file's frontmatter. */
function readExtractTimestamp(extractPath: string): string | null {
  try {
    const content = fs.readFileSync(extractPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = YAML.parse(fmMatch[1]) as Record<string, unknown>;
    return typeof fm.generated === 'string' ? fm.generated : null;
  } catch {
    return null;
  }
}

export function handleDigestHealth(
  deps: DigestHealthDeps,
): (req: RouteRequest) => Promise<RouteResponse> {
  return async () => {
    const tracePath = path.join(deps.vaultDir, 'digest', 'trace.jsonl');
    const lastCycle = readLastRecord<DigestCycleResult>(tracePath);

    // Trace may be stale if a cycle was interrupted before appendTrace().
    // Cross-check against extract files' generated timestamps.
    let lastCycleTimestamp = lastCycle?.timestamp ?? null;
    const digestDir = path.join(deps.vaultDir, 'digest');
    try {
      for (const file of fs.readdirSync(digestDir)) {
        if (!file.startsWith('extract-') || !file.endsWith('.md')) continue;
        const extractTs = readExtractTimestamp(path.join(digestDir, file));
        if (extractTs && (!lastCycleTimestamp || extractTs > lastCycleTimestamp)) {
          lastCycleTimestamp = extractTs;
        }
      }
    } catch {
      // digest dir may not exist
    }

    const substrateReady = deps.pipeline.newSubstrateSinceLastDigest();

    return {
      body: {
        last_cycle: lastCycleTimestamp ? {
          cycle_id: lastCycle?.cycleId ?? null,
          timestamp: lastCycleTimestamp,
          substrate_count: lastCycle ? Object.values(lastCycle.substrate).flat().length : null,
          tiers_generated: lastCycle?.tiersGenerated ?? null,
          duration_ms: lastCycle?.durationMs ?? null,
          model: lastCycle?.model ?? null,
        } : null,
        substrate_ready: substrateReady,
        substrate_threshold: deps.minNotesForCycle,
        metabolism_state: deps.metabolismState(),
        digest_ready: deps.digestReady(),
        cycle_in_progress: deps.cycleInProgress(),
      },
    };
  };
}

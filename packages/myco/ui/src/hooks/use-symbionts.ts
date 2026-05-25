import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { useProjectScopedQueryKey } from './use-project-selection';

/* ---------- Constants ---------- */

/** Cache TTL for symbiont list (rarely changes — 5 minutes). */
const SYMBIONTS_STALE_TIME = 300_000;

/* ---------- Types ---------- */

export interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  enabled: boolean;
  resumeCommand?: string;
  supportsSessionStartInjection: boolean;
  supportsPromptSubmitInjection: boolean;
  /** Whether the agent's detectionDir exists on this machine. */
  detected: boolean;
  /** Whether Myco's hook block is present in the agent's global config. */
  globallyInstalled: boolean;

  // Capability profile — populated by the daemon from the symbiont
  // manifest, consumed by `capability-map.ts` to render chips on the
  // Symbionts page.
  supportsSessions: boolean;
  supportsCanopyInjection: boolean;
  supportsPlanCapture: boolean;
  supportsSkills: boolean;
  supportsMcp: boolean;
  /** Recent Myco MCP tool calls observed (last 7 days). Omitted when
   *  `supportsMcp === false`. */
  mcpActive?: boolean;
  /** Explicit project-level override. Omitted when no override is set
   *  — the effective `enabled` value then comes from the global default. */
  projectOverride?: { enabled: boolean };
}

interface SymbiontsResponse {
  symbionts: SymbiontInfo[];
}

/* ---------- Hook ---------- */

export function useSymbionts() {
  const queryKey = useProjectScopedQueryKey(['symbionts']);
  return useQuery<SymbiontsResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<SymbiontsResponse>('/symbionts', { signal }),
    staleTime: SYMBIONTS_STALE_TIME,
  });
}

/* ---------- Helpers ---------- */

/**
 * Build a resume command for the given agent and session ID.
 * Uses the manifest-declared resumeCommand template with {sessionId} placeholder.
 * Returns null if the agent has no resume command (IDE-based agents).
 */
export function buildResumeCommand(
  symbionts: SymbiontInfo[],
  agent: string,
  sessionId: string,
): string | null {
  const symbiont = symbionts.find((s) => s.name === agent);
  if (!symbiont?.resumeCommand) return null;
  return symbiont.resumeCommand.replace('{sessionId}', sessionId);
}

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for symbiont list (rarely changes — 5 minutes). */
const SYMBIONTS_STALE_TIME = 300_000;

/* ---------- Types ---------- */

export interface SymbiontInfo {
  name: string;
  displayName: string;
  binary: string;
  resumeCommand?: string;
}

interface SymbiontsResponse {
  symbionts: SymbiontInfo[];
}

/* ---------- Hook ---------- */

export function useSymbionts() {
  return useQuery<SymbiontsResponse>({
    queryKey: ['symbionts'],
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

import { type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { usePaged } from './use-paged';

export interface RunListRow {
  id: string;
  agentId: string;
  task: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  startedAt: number | null;
  resumedAt: number | null;
  completedAt: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  costSource: string | null;
  dryRun: boolean;
  resumable: boolean;
  resumeStatus: string | null;
  failed: boolean;
  queuedAt: number | null;
  heldBy: string | null;
  position: number | null;
}

export interface RunDetailRow extends RunListRow {
  instruction: string | null;
  sessionRef: string | null;
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  reasoningLevel: string | null;
  resumeMode: string | null;
  resumeAttempts: number;
  error: string | null;
  dispatchedBy: string | null;
  usageData: string | null;
  actionsTaken: string | null;
}

export interface PhaseRow {
  name: string;
  status: string;
  updatedAt: number | null;
  summary: string | null;
  turnsUsed: number | null;
  allowedMaxTurns: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  costSource: string | null;
  capHit: boolean;
  semanticCheckBlocked: boolean;
  postConditionFailed: boolean;
}

export interface ReportRow {
  id: number;
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  createdAt: number;
}

export interface RunDetailResponse {
  run: RunDetailRow;
  /** Empty when the run recorded no phases; null when its record could not be read. */
  phases: PhaseRow[] | null;
  reports: ReportRow[];
  projectId: string;
}

export interface AgentRow {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
}

export interface SkillRecord {
  id: string;
  agentId: string;
  name: string;
  displayName: string;
  description: string;
  status: string;
  generation: number;
  sourceIds: string;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LineageRow {
  id: string;
  skillId: string;
  generation: number;
  action: string;
  rationale: string;
  sourceIdsAdded: string;
  contentSnapshot: string;
  createdAt: number;
}

export interface ReleaseStateRow {
  id: string;
  namespace: string;
  recordId: string;
  state: string;
  confidence: string;
  basisKind: string | null;
  basisRef: string | null;
  basisSha: string | null;
  releasePrNumber: number | null;
  reason: string | null;
  checkedAt: number;
}

export interface SporeRow {
  id: string;
  agentId: string;
  sessionId: string | null;
  promptId: string | null;
  observationType: string;
  status: string;
  content: string;
  context: string | null;
  importance: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  createdAt: number;
  updatedAt: number | null;
  embedded: number;
}

export interface SporesResponse {
  spores: SporeRow[];
  total: number;
  maxPage: number;
}

export interface SporeResponse {
  spore: SporeRow;
  /** Every spore recorded as replacing this one, newest first. */
  supersededBy: string[];
  /** Every spore this one replaced, newest first. */
  supersedes: string[];
}

export interface DigestRow {
  id: string;
  agentId: string;
  tier: number;
  content: string;
  substrateHash: string | null;
  generatedAt: number;
}

export interface DigestRevisionRow {
  id: number;
  tier: number;
  content: string;
  metadata: string | null;
  runId: string | null;
  parentRevisionId: number | null;
  createdAt: number;
}

export interface InstructionsRow {
  id: string;
  agentId: string;
  content: string;
  inputHash: string;
  sourceRunId: string | null;
  generatedAt: number;
}

const seg = (value: string) => encodeURIComponent(value);
const project = (projectId: string) => `/api/projects/${seg(projectId)}`;

/** A project's runs, newest first; `status` narrows to one status or, null, none. */
export function useRuns(projectId: string, status: string | null) {
  return usePaged<RunListRow>(['runs', projectId, status ?? 'all'], `${project(projectId)}/runs?limit=50${status === null ? '' : `&status=${seg(status)}`}`);
}

/** One run in full. A watcher passes `enabled` and `retry` to follow a run that may not have claimed yet. */
export function useRun(projectId: string, runId: string, options: Pick<UseQueryOptions<RunDetailResponse>, 'enabled' | 'retry'> = {}) {
  return useQuery({ queryKey: ['run', projectId, runId], queryFn: ({ signal }) => fetchJson<RunDetailResponse>(`${project(projectId)}/runs/${seg(runId)}`, signal), ...options });
}

export function useAgents() {
  return useQuery({ queryKey: ['agents'], queryFn: ({ signal }) => fetchJson<{ agents: AgentRow[] }>('/api/agents', signal) });
}

export function useSkills(projectId: string) {
  return useQuery({ queryKey: ['skills', projectId], queryFn: ({ signal }) => fetchJson<{ skills: SkillRecord[] }>(`${project(projectId)}/skills?limit=200`, signal) });
}

export function useSkill(projectId: string, skillId: string) {
  return useQuery({ queryKey: ['skill', projectId, skillId], queryFn: ({ signal }) => fetchJson<{ content: string | null; lineage: LineageRow[] }>(`${project(projectId)}/skills/${seg(skillId)}`, signal) });
}

export function useSkillReleaseStates(projectId: string) {
  return useQuery({
    queryKey: ['release-states', projectId, 'skill'],
    queryFn: ({ signal }) => fetchJson<{ releaseStates: ReleaseStateRow[] }>(`${project(projectId)}/release-states?namespace=skill&limit=200`, signal),
  });
}

/** How many spores one page of the rail holds. */
export const SPORE_PAGE_SIZE = 25;

export interface SporeFilters {
  /** One status; every status when absent. */
  status?: string;
  /** One observation type; every type when absent. */
  type?: string;
  /** Matches the content or the type. */
  q?: string;
  /** Narrows to the spores one session produced. */
  session?: string;
  limit?: number;
  offset?: number;
}

function sporeQuery(filters: SporeFilters): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? SPORE_PAGE_SIZE));
  if (filters.status !== undefined && filters.status !== '') params.set('status', filters.status);
  if (filters.type !== undefined && filters.type !== '') params.set('type', filters.type);
  if (filters.q !== undefined && filters.q !== '') params.set('q', filters.q);
  if (filters.session !== undefined && filters.session !== '') params.set('session', filters.session);
  if (filters.offset !== undefined && filters.offset > 0) params.set('offset', String(filters.offset));
  return params.toString();
}

/** A project's spores, newest first, with the count the filters match. */
export function useSpores(projectId: string, filters: SporeFilters = {}) {
  const query = sporeQuery(filters);
  return useQuery({
    queryKey: ['spores', projectId, query],
    queryFn: ({ signal }) => fetchJson<SporesResponse>(`${project(projectId)}/spores?${query}`, signal),
  });
}

/** One spore with its lineage in both directions. */
export function useSpore(projectId: string, sporeId: string) {
  return useQuery({
    queryKey: ['spore', projectId, sporeId],
    queryFn: ({ signal }) => fetchJson<SporeResponse>(`${project(projectId)}/spores/${seg(sporeId)}`, signal),
  });
}

export function useDigests(projectId: string) {
  return useQuery({ queryKey: ['digests', projectId], queryFn: ({ signal }) => fetchJson<{ digests: DigestRow[] }>(`${project(projectId)}/digests`, signal) });
}

export function useDigestRevisions(projectId: string, agentId: string, tier: number) {
  return useQuery({ queryKey: ['digest-revisions', projectId, agentId, tier], queryFn: ({ signal }) => fetchJson<{ revisions: DigestRevisionRow[] }>(`${project(projectId)}/digests/${tier}/revisions?agentId=${seg(agentId)}`, signal) });
}

export function useInstructions(projectId: string) {
  return useQuery({ queryKey: ['instructions', projectId], queryFn: ({ signal }) => fetchJson<{ instructions: InstructionsRow[] }>(`${project(projectId)}/cortex/instructions`, signal) });
}

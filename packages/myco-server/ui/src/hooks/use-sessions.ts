import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchJson, SignedOutError } from '../lib/api';
import { usePaged } from './use-paged';

export interface SessionRow {
  sessionId: string;
  machineId: string | null;
  createdByTokenId: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  originPath: string | null;
  parentSessionId: string | null;
  parentReason: string | null;
  memberId: string | null;
  memberLabel: string | null;
  runtimeLabel: string | null;
  runtimeKind: string | null;
}

export interface SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

export interface SessionResponse {
  session: SessionRow;
  counts: SessionCounts;
  projectId: string;
}

export interface PromptRow {
  promptId: string;
  text: string | null;
  blobKey: string | null;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface ToolCallRow {
  toolCallId: string;
  promptId: string | null;
  toolName: string;
  mycoTool: string | null;
  mycoOp: string | null;
  inputPreview: string | null;
  inputBytes: number | null;
  inputBlobKey: string | null;
  outputPreview: string | null;
  outputBlobKey: string | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number | null;
  filesAffected: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface ResponseRow {
  responseId: string;
  promptId: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface PlanRow {
  planKey: string;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  createdAt: number;
  updatedAt: number;
  orderedAt: number;
}

export interface AttachmentRow {
  attachmentId: string;
  blobKey: string;
  mediaType: string;
  byteSize: number;
  description: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface TranscriptResponse {
  transcript: {
    transcriptId: string;
    sessionId: string;
    machineId: string;
    agent: string | null;
    originPath: string | null;
    size: number;
    segmentCount: number;
    firstReceivedAt: number;
    lastReceivedAt: number;
  };
  segments: { baseOffset: number; length: number; blobKey: string; createdAt: number }[];
}

export interface FeedItem {
  type: 'session' | 'run' | 'spore';
  id: string;
  summary: string;
  at: number;
  sessionId: string | null;
}

export interface ProjectStats {
  sessions: number;
  openSessions: number;
  sessionsLast7d: number;
  prompts: number;
  toolCalls: number;
  plans: number;
  attachments: number;
  lastActivityAt: number | null;
}

export type SessionChild = 'prompts' | 'tool-calls' | 'responses' | 'plans' | 'attachments';

/** The image types the blob route serves with their stored type; anything else is served as a download and cannot render inline. */
export const RENDERABLE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const seg = (value: string) => encodeURIComponent(value);
const project = (projectId: string) => `/api/projects/${seg(projectId)}`;

export const blobUrl = (projectId: string, key: string) => `${project(projectId)}/blobs/${seg(key)}`;

export function useSessions(projectId: string) {
  return usePaged<SessionRow>(['sessions', projectId], `${project(projectId)}/sessions?limit=50`);
}

export function useSession(projectId: string, sessionId: string) {
  return useQuery({ queryKey: ['session', projectId, sessionId], queryFn: ({ signal }) => fetchJson<SessionResponse>(`${project(projectId)}/sessions/${seg(sessionId)}`, signal) });
}

export function useSessionChildren<T>(projectId: string, sessionId: string, child: SessionChild) {
  return usePaged<T>(['session-children', projectId, sessionId, child], `${project(projectId)}/sessions/${seg(sessionId)}/${child}?limit=100`);
}

/** The transcript record, or null when the session has none — the one 404 here that is an answer rather than an error. */
export function useTranscript(projectId: string, sessionId: string) {
  return useQuery({
    queryKey: ['transcript', projectId, sessionId],
    queryFn: async ({ signal }) => {
      try {
        return await fetchJson<TranscriptResponse>(`${project(projectId)}/sessions/${seg(sessionId)}/transcript`, signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useActivity(projectId: string) {
  return useQuery({ queryKey: ['activity', projectId], queryFn: ({ signal }) => fetchJson<{ items: FeedItem[]; stats: ProjectStats }>(`${project(projectId)}/activity`, signal) });
}

/** The text of a blob, read as text whatever it happens to contain. Blobs are content-addressed and immutable, so a fetched one is never refetched. */
export function useBlobText(projectId: string, key: string) {
  return useQuery({
    queryKey: ['blob-text', projectId, key],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await fetch(blobUrl(projectId, key), { credentials: 'same-origin', signal });
      if (res.status === 401) throw new SignedOutError();
      if (!res.ok) throw new ApiError(res.status, null);
      return res.text();
    },
  });
}

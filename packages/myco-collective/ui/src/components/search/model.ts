import type { SearchResultRecord } from '../../lib/types';
import { formatScore, titleCaseFromSnake } from '../../lib/format';

const PREVIEW_MAX_CHARS = 200;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function titleFromResult(result: SearchResultRecord): string {
  return (
    asString(result.title) ??
    asString(result.name) ??
    asString(result.path)?.split('/').pop() ??
    [asString(result.table) ?? 'result', asString(result.id) ?? 'unidentified'].join(':')
  );
}

function previewFromResult(result: SearchResultRecord): string | null {
  const preview = asString(result.preview) ?? asString(result.description);
  if (preview) return truncate(preview, PREVIEW_MAX_CHARS);

  const fallbackField = [
    asString(result.observation_type),
    asString(result.status),
    asString(result.path),
  ]
    .filter(Boolean)
    .join(' · ');

  return fallbackField || null;
}

function projectLabel(result: SearchResultRecord): string {
  return result.project?.name ?? 'Unknown project';
}

function metadataEntries(result: SearchResultRecord): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const candidates: Array<[string, unknown]> = [
    ['Type', result.table],
    ['Observation', result.observation_type],
    ['Status', result.status],
    ['Path', result.path],
    ['Session', result.session_id],
  ];

  for (const [label, value] of candidates) {
    const stringValue = asString(value);
    if (stringValue) {
      entries.push([label, stringValue]);
    }
  }

  if (typeof result.started_at === 'number') {
    entries.push(['Started At', new Date(result.started_at * 1000).toLocaleString('en-US')]);
  }

  return entries;
}

function detailsSummary(result: SearchResultRecord): string {
  const table = asString(result.table);
  if (table) return titleCaseFromSnake(table);
  return 'Result';
}

export interface NormalizedSearchResult {
  key: string;
  title: string;
  preview: string | null;
  projectName: string;
  projectWorkerUrl: string | null;
  typeLabel: string;
  scoreLabel: string;
  metadata: Array<[string, string]>;
  raw: SearchResultRecord;
  deepLink: string | null;
}

export function normalizeSearchResult(result: SearchResultRecord, index: number): NormalizedSearchResult {
  return {
    key: `${projectLabel(result)}:${asString(result.id) ?? index}`,
    title: titleFromResult(result),
    preview: previewFromResult(result),
    projectName: projectLabel(result),
    projectWorkerUrl: result.project?.worker_url ?? null,
    typeLabel: detailsSummary(result),
    scoreLabel: formatScore(result.score),
    metadata: metadataEntries(result),
    raw: result,
    deepLink: asString(result.url),
  };
}

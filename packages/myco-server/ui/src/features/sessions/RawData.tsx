import { useEffect, useRef, type ReactNode } from 'react';
import { ActionLink, Disclosure, ErrorState, ExternalLink, FactRow, FactsPanel, LoadingState, ShowMore } from '../../design';
import {
  blobUrl, processedBodyUrl, PROMPT_ORIGINS, RENDERABLE_IMAGE_TYPES, useSessionChildren, useTranscript, useTurns,
  type AttachmentRow, type ContextInjectionRow, type TranscriptRecord, type TurnRow,
} from '../../hooks/use-sessions';
import { formatBytes } from '../../lib/format';
import { ApiError } from '../../lib/api';
import { useMe } from '../../hooks/use-me';
import { promptPreview } from './Turn';
import { count, dateTime } from './words';

/** The parts of the raw data a link can open to, by the `raw` parameter. */
export const RAW_SECTIONS = ['transcript', 'context', 'attachments'] as const;
export type RawSection = (typeof RAW_SECTIONS)[number];

export function isRawSection(value: string | null): value is RawSection {
  return value !== null && (RAW_SECTIONS as readonly string[]).includes(value);
}

/**
 * What the session was captured from, folded away at the foot of the page:
 * the transcript files and their stored pieces, the context Myco prepared for
 * the session, and every attachment. It is for debugging, not reading.
 */
export function RawData({ projectId, sessionId, open, now }: { projectId: string; sessionId: string; open: RawSection | null; now: number }) {
  return (
    <section aria-label="Raw data" data-raw-data="" className="border-t border-line pt-s4">
      <Disclosure defaultOpen={open !== null} summary="Raw data">
        <div className="flex flex-col gap-s6 pt-s4">
          <RawPart id="transcript" title="Transcript files" scrollTo={open === 'transcript'}>
            <Transcripts projectId={projectId} sessionId={sessionId} now={now} />
          </RawPart>
          <RawPart id="context" title="Context Myco prepared" scrollTo={open === 'context'}>
            <ContextHistory projectId={projectId} sessionId={sessionId} now={now} />
          </RawPart>
          <RawPart id="attachments" title="Attachments" scrollTo={open === 'attachments'}>
            <Attachments projectId={projectId} sessionId={sessionId} now={now} />
          </RawPart>
        </div>
      </Disclosure>
    </section>
  );
}

function RawPart({ id, title, scrollTo, children }: { id: RawSection; title: string; scrollTo: boolean; children: ReactNode }) {
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollTo && typeof el.current?.scrollIntoView === 'function') el.current.scrollIntoView({ block: 'start' });
  }, [scrollTo]);
  return (
    <section ref={el} aria-label={title} data-raw={id} className="flex flex-col gap-s3">
      <h3 className="t-h3 text-ink">{title}</h3>
      {children}
    </section>
  );
}

/** What a session's record can tell you, in the reader's terms rather than the parser's. */
export function readState(t: Pick<TranscriptRecord, 'parseError' | 'parsedOffset' | 'size' | 'fidelity'>): string {
  if (t.parseError !== null) return 'Could not be read in full';
  if (t.parsedOffset < t.size) return 'Still being read';
  if (t.fidelity !== null && t.fidelity !== 'full') return 'Read; this format may leave out some tool results';
  return 'Read';
}

/**
 * The transcripts a session holds and their stored pieces, each a link; the
 * bytes are never fetched here, as a transcript runs to megabytes.
 *
 * A session holds one transcript of its own and one more per subagent. A
 * payload carrying no list is read as nothing captured rather than rendered.
 */
function Transcripts({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const permission = useMe().data?.permissions?.raw;
  const transcript = useTranscript(projectId, sessionId, permission?.scope === 'own');
  if (permission?.scope !== 'own') return <p role="alert" className="t-small text-muted">{permission?.reason ?? 'Raw transcripts are private to their uploader.'}</p>;
  if (transcript.isPending) return <LoadingState label="Loading the transcript" count={2} />;
  if (transcript.error instanceof ApiError && transcript.error.status === 403) return <p role="alert" className="t-small text-muted">Raw transcripts are private to the member whose machine uploaded them.</p>;
  if (transcript.error) return <ErrorState error={transcript.error} onRetry={() => void transcript.refetch()} />;
  const held = Array.isArray(transcript.data?.transcripts) ? transcript.data.transcripts : [];
  if (held.length === 0) return <p className="t-small text-muted">No transcript captured.</p>;
  return (
    <div className="flex flex-col gap-s3">
      {held.map((t) => (
        <FactsPanel
          key={t.transcriptId}
          title={t.role === 'subagent' ? 'A sub-agent’s transcript' : 'The session’s transcript'}
          actions={(
            <ul aria-label="Transcript segments" className="flex w-full flex-col gap-s1">
              {(t.segments ?? []).map((s) => (
                <li key={s.baseOffset} className="flex flex-wrap items-baseline gap-x-s3 t-small">
                  <ExternalLink href={blobUrl(projectId, s.blobKey)} className="t-mono">bytes {s.baseOffset.toLocaleString()}–{(s.baseOffset + s.length).toLocaleString()}</ExternalLink>
                  <span className="text-muted">{formatBytes(s.length)} · {dateTime(s.createdAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
        >
          <FactRow term="Size">{formatBytes(t.size)} · {count(t.segmentCount, 'piece')}</FactRow>
          <FactRow term="State">{readState(t)}</FactRow>
          {t.originPath !== null && <FactRow term="File" mono>{t.originPath}</FactRow>}
          <FactRow term="First received">{dateTime(t.firstReceivedAt, now)}</FactRow>
          <FactRow term="Last received">{dateTime(t.lastReceivedAt, now)}</FactRow>
        </FactsPanel>
      ))}
    </div>
  );
}

function contextLabel(kind: string): string {
  if (kind === 'cortex') return 'At the session’s start';
  if (kind === 'plan-nudge') return 'A reminder to keep its plan';
  if (kind.startsWith('cortex-compact:')) return `After the conversation was compacted (${kind.slice('cortex-compact:'.length)})`;
  if (kind.startsWith('cortex:')) return `For a sub-agent (${kind.slice('cortex:'.length)})`;
  return kind;
}

function ContextHistory({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const context = useSessionChildren<ContextInjectionRow>(projectId, sessionId, 'context-injections');
  if (context.isPending) return <LoadingState label="Loading the context history" count={2} />;
  if (context.error) return <ErrorState error={context.error} onRetry={context.retry} />;
  return (
    <div className="flex flex-col gap-s2">
      <p className="t-small text-muted">What Myco prepared for this session. A record here does not confirm that the agent received it.</p>
      {context.rows.length === 0 ? <p className="t-small text-muted">Nothing was prepared for this session.</p> : (
        <ul aria-label="Context records" className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface-1">
          {context.rows.map((record) => (
            <li key={`${record.kind}/${record.createdAt}`} className="flex flex-wrap items-baseline justify-between gap-s2 px-s4 py-s2 t-small">
              <span className="text-ink-2">{contextLabel(record.kind)}</span>
              <time dateTime={new Date(record.createdAt).toISOString()} className="text-muted">{dateTime(record.createdAt, now)}</time>
            </li>
          ))}
        </ul>
      )}
      {context.hasMore && <ShowMore shown={context.rows.length} noun="records" onMore={context.more} pending={context.isFetchingMore} hasMore />}
    </div>
  );
}

interface AttachmentGroup { key: string; label: string; rows: AttachmentRow[]; /** The top-level turn the group opens, when it has one. */ turn: string | null }

/** The attachments a turn carries, grouped under the turn in turn order; those on prompts the conversation does not list on its own share one group, and those tied to no prompt sit last. */
export function attachmentGroups(rows: readonly AttachmentRow[], turns: readonly TurnRow[]): AttachmentGroup[] {
  const byPrompt = new Map<string | null, AttachmentRow[]>();
  for (const row of rows) byPrompt.set(row.promptId, [...(byPrompt.get(row.promptId) ?? []), row]);
  const groups: AttachmentGroup[] = [];
  for (const turn of turns) {
    const mine = byPrompt.get(turn.promptId);
    if (mine !== undefined) { groups.push({ key: turn.promptId, label: promptPreview(turn), rows: mine, turn: turn.promptId }); byPrompt.delete(turn.promptId); }
  }
  const untied = byPrompt.get(null) ?? [];
  byPrompt.delete(null);
  const other = [...byPrompt.values()].flat();
  if (other.length > 0) groups.push({ key: 'other', label: 'Other prompts in this session', rows: other, turn: null });
  if (untied.length > 0) groups.push({ key: 'none', label: 'Not tied to a prompt', rows: untied, turn: null });
  return groups;
}

function Attachments({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const attachments = useSessionChildren<AttachmentRow>(projectId, sessionId, 'attachments');
  const turns = useTurns(projectId, sessionId, PROMPT_ORIGINS);
  if (attachments.isPending || turns.isPending) return <LoadingState label="Loading the attachments" count={2} />;
  const error = attachments.error ?? turns.error;
  if (error) return <ErrorState error={error} onRetry={() => { attachments.retry(); turns.retry(); }} />;
  if (attachments.rows.length === 0) return <p className="t-small text-muted">No attachments in this session.</p>;
  return (
    <div className="flex flex-col gap-s5">
      {attachmentGroups(attachments.rows, turns.rows).map((group) => (
        <section key={group.key} aria-label={group.label} className="flex flex-col gap-s2">
          <div className="flex items-baseline justify-between gap-s3">
            <h4 className="min-w-0 truncate t-small font-medium text-ink-2">{group.label}</h4>
            {group.turn !== null && (
              <ActionLink to={`?turn=${encodeURIComponent(group.turn)}`} className="shrink-0">Open the prompt</ActionLink>
            )}
          </div>
          <ul className="grid gap-s3 sm:grid-cols-2" aria-label={`Attachments of ${group.label}`}>
            {group.rows.map((a) => (
              <li key={a.attachmentId} className="flex flex-col gap-s2 rounded-card border border-line bg-surface-1 p-s3">
                {RENDERABLE_IMAGE_TYPES.includes(a.mediaType) ? (
                  <img src={processedBodyUrl(projectId, { kind: 'attachment', id: a.attachmentId })} alt={a.description ?? 'An attached image'} className="max-h-[256px] w-auto rounded-control" />
                ) : (
                  <ExternalLink href={processedBodyUrl(projectId, { kind: 'attachment', id: a.attachmentId })} className="t-small">Download {a.description ?? 'the attachment'}</ExternalLink>
                )}
                <span className="t-meta text-muted">{a.mediaType} · {formatBytes(a.byteSize)} · {dateTime(a.createdAt, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {attachments.hasMore && <ShowMore shown={attachments.rows.length} noun="attachments" onMore={attachments.more} pending={attachments.isFetchingMore} hasMore />}
    </div>
  );
}

import type { ReactNode } from 'react';
import { Disclosure, ErrorState, LoadingState, TypeChip } from '../../design';
import { useCurationAnswer } from '../../hooks/use-work';
import { ApiError } from '../../lib/api';
import { sporeStatusWord } from '../knowledge/words';
import { sporeTypeWord } from '../today/words';
import { PartLabel } from './OutcomeCard';
import type { CurationAnswer, CurationNote, CurationSource } from './wire';

/** New spores written from the same sources, in the answer's order, with each one's index in it. */
interface Change { sources: string[]; writes: { note: CurationNote; index: number }[] }

/** The answer's new spores joined wherever they share a source: one merge, split or rewrite per change. */
function changesOf(answer: CurationAnswer): Change[] {
  let changes: Change[] = [];
  answer.notes.forEach((note, index) => {
    const joined = changes.filter((change) => note.sources.some((id) => change.sources.includes(id)));
    const sources = [...new Set([...joined.flatMap((change) => change.sources), ...note.sources])];
    const writes = [...joined.flatMap((change) => change.writes), { note, index }].sort((a, b) => a.index - b.index);
    changes = [...changes.filter((change) => !joined.includes(change)), { sources, writes }];
  });
  return changes.sort((a, b) => a.writes[0]!.index - b.writes[0]!.index);
}

/** What one change does, said as a preview proposes it or as an applied run did it. */
function changeWords({ sources, writes }: Change, preview: boolean): string {
  const [would, merge, split, rewrite] = preview ? ['Would ', 'merge', 'split', 'rewrite'] : ['', 'Merged', 'Split', 'Rewrote'];
  if (sources.length > 1 && writes.length === 1) return `${would}${merge} ${sources.length} spores into one`;
  if (sources.length === 1 && writes.length > 1) return `${would}${split} this spore into ${writes.length}`;
  if (sources.length === 1) return `${would}${rewrite} this spore`;
  return `${would}${rewrite} ${sources.length} spores as ${writes.length}`;
}

/** How a source reads now against how the run was offered it, when that differs in a way the reader must notice. */
function sourceState(source: CurationSource, preview: boolean): string | null {
  const { current } = source;
  if (current === null) return 'This spore is no longer held, so its text can’t be shown.';
  const status = current.status === 'active' ? '' : ` It is now ${sporeStatusWord(current.status).toLowerCase()}.`;
  if (preview) return current.revision === source.revision && status === '' ? null : `Changed since this preview; shown as it reads now.${status}`;
  if (current.revision > source.revision + 1) return `Changed since this curation; shown as it reads now.${status}`;
  return status === '' ? null : status.trim();
}

const spaced = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** Whether the body's first sentence is the line itself, so showing the line above it would say it twice. */
function opensWith(body: string, line: string): boolean {
  const said = spaced(line).replace(/[.!?:;]+$/, '');
  const text = spaced(body);
  return said !== '' && text.startsWith(said) && (text.length === said.length || /^[.!?:;]/.test(text.slice(said.length)));
}

function Text({ type, line, body }: { type: string; line: string | null; body: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-s1">
      <TypeChip className="self-start">{sporeTypeWord(type)}</TypeChip>
      {line !== null && line.trim() !== '' && !opensWith(body, line) && <p className="break-words t-small font-medium text-ink" data-curation-line="">{line}</p>}
      <p className="whitespace-pre-wrap break-words t-small text-ink-2" data-curation-body="">{body}</p>
    </div>
  );
}

function Source({ source, preview }: { source: CurationSource | undefined; preview: boolean }) {
  if (source === undefined) return <li className="t-small text-muted">This spore wasn’t recorded with the run.</li>;
  const state = sourceState(source, preview);
  return (
    <li className="flex flex-col gap-s1 rounded-control border border-line px-s3 py-s2" data-curation-source={source.current === null ? 'gone' : state === null ? 'same' : 'changed'}>
      {state !== null && <p className="t-meta text-warn">{state}</p>}
      {source.current !== null && <Text type={source.current.observationType} line={source.current.agentLine} body={source.current.content} />}
    </li>
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-s2"><PartLabel>{label}</PartLabel><ul className="flex flex-col gap-s2">{children}</ul></div>;
}

/**
 * A curation run's decision for a person to judge: each merge, split or rewrite with the spores it starts from beside
 * the full text of what it writes, what it keeps and what it retires and why. Admins only: the read is theirs.
 */
export function CurationDecision({ projectId, runId, preview, finished }: { projectId: string; runId: string; preview: boolean; finished: boolean }) {
  const read = useCurationAnswer(projectId, runId, true);
  const title = preview ? 'What curation would do' : 'What curation did';
  if (read.isPending) return <LoadingState label="Loading the curation decision" count={1} />;
  if (read.isError) {
    if (read.error instanceof ApiError && read.error.status === 404) return finished
      ? <section aria-label={title} className="flex flex-col gap-s2"><PartLabel>{title}</PartLabel><p className="t-small text-muted" data-curation-decision="none">No decision was recorded for this run.</p></section>
      : null;
    return <ErrorState error={read.error} onRetry={() => void read.refetch()} />;
  }
  const { checked, sources } = read.data;
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (checked === null) return finished
    ? <section aria-label={title} className="flex flex-col gap-s2"><PartLabel>{title}</PartLabel><p className="t-small text-muted" data-curation-decision="none">No decision was accepted for this run.</p></section>
    : null;
  const { answer } = checked;
  const coveredBy = (by: string) => by.startsWith('new:')
    ? `the new spore “${answer.notes[Number(by.slice(4))]?.agent_line ?? 'not recorded'}”`
    : `the kept spore “${byId.get(by)?.current?.agentLine ?? 'not recorded'}”`;
  return (
    <section aria-label={title} className="flex flex-col gap-s4" data-curation-decision={preview ? 'preview' : 'applied'}>
      <PartLabel>{title}</PartLabel>
      {preview && <p className="rounded-control border border-line bg-ok-bg px-s3 py-s2 t-small text-ink-2" data-curation-preview-mark="">
        <span className="font-medium text-ink">Preview: nothing was changed.</span> The spores below still read as shown, and none of the new ones was written.
      </p>}
      <p className="t-small text-ink-2" data-curation-reason=""><span className="font-medium text-ink">Its reason: </span>{answer.reason}</p>
      {changesOf(answer).map((change) => (
        <article key={change.writes[0]!.index} className="flex flex-col gap-s2" data-curation-change="">
          <h4 className="t-small font-medium text-ink">{changeWords(change, preview)}</h4>
          <div className="grid gap-s3 md:grid-cols-2">
            <Column label={preview ? 'Now' : 'Before'}>{change.sources.map((id) => <Source key={id} source={byId.get(id)} preview={preview} />)}</Column>
            <Column label={preview ? 'Would become' : 'Became'}>{change.writes.map(({ note, index }) => (
              <li key={index} className="rounded-control border border-line bg-surface-2 px-s3 py-s2" data-curation-write=""><Text type={note.observation_type} line={note.agent_line} body={note.content} /></li>
            ))}</Column>
          </div>
        </article>
      ))}
      {answer.retire.map((item) => (
        <article key={item.id} className="flex flex-col gap-s2" data-curation-retire="">
          <h4 className="t-small font-medium text-ink">{preview ? 'Would retire this spore' : 'Retired this spore'}</h4>
          <p className="t-small text-ink-2">{item.reason} Covered by {coveredBy(item.made_unnecessary_by)}</p>
          <ul className="flex flex-col gap-s2"><Source source={byId.get(item.id)} preview={preview} /></ul>
        </article>
      ))}
      {answer.keep.length > 0 && (
        <article className="flex flex-col gap-s2" data-curation-keep="">
          <h4 className="t-small font-medium text-ink">{answer.keep.length === 1 ? (preview ? 'Would keep this spore as it is' : 'Kept this spore as it is') : (preview ? `Would keep ${answer.keep.length} spores as they are` : `Kept ${answer.keep.length} spores as they are`)}</h4>
          <ul className="flex flex-col gap-s2">{answer.keep.map((id) => <Source key={id} source={byId.get(id)} preview={preview} />)}</ul>
        </article>
      )}
      {!preview && <Disclosure summary="The answer as recorded"><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words t-mono">{JSON.stringify(answer, null, 2)}</pre></Disclosure>}
    </section>
  );
}

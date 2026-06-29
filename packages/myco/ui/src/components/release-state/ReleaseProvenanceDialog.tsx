// SPDX-License-Identifier: Apache-2.0

import { Link } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useReleaseProvenanceDetail, type ReleaseProvenanceDetail } from '../../hooks/use-release-provenance';
import { cn } from '../../lib/cn';

const SETTINGS_LINK = '/settings?configSection=release-provenance#release-provenance';

export interface ReleaseProvenanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  namespace: string;
  recordId: string;
}

export function ReleaseProvenanceDialog({
  open,
  onOpenChange,
  namespace,
  recordId,
}: ReleaseProvenanceDialogProps): JSX.Element {
  const { data, isLoading, isError, error } = useReleaseProvenanceDetail(namespace, recordId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Release provenance</DialogTitle>
            <DialogDescription className="break-all font-mono">
              {namespace}/{recordId}
            </DialogDescription>
          </DialogHeader>
          {isLoading ? (
            <div className="font-sans text-sm text-on-surface-variant">Loading provenance details...</div>
          ) : isError ? (
            <div className="rounded-md border border-terracotta/30 bg-terracotta/10 p-3 font-sans text-sm text-terracotta">
              {error instanceof Error ? error.message : 'Failed to load release provenance'}
            </div>
          ) : data ? (
            <ReleaseProvenanceContent detail={data} />
          ) : (
            <div className="font-sans text-sm text-on-surface-variant">No provenance record found.</div>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function ReleaseProvenanceContent({ detail }: { detail: ReleaseProvenanceDetail }): JSX.Element {
  const annotation = detail.annotation;
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3">
        <Field label="Status" value={annotation.state} />
        <Field label="Confidence" value={annotation.confidence} />
        <Field label="Basis" value={annotation.basis_kind ?? 'unknown'} />
      </section>

      <section className="space-y-2">
        <h3 className="myco-eyebrow-sm">Reason</h3>
        <p className="break-words font-sans text-sm text-on-surface">
          {annotation.reason ?? 'No reason was recorded.'}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Field label="Checked" value={formatEpoch(annotation.checked_at)} />
        <Field label="Reference" value={annotation.basis_ref ?? 'none'} />
        <Field label="SHA" value={annotation.basis_sha ?? 'none'} />
        <Field label="Release PR" value={annotation.release_pr_number ? `#${annotation.release_pr_number}` : 'none'} />
      </section>

      <section className="space-y-2">
        <h3 className="myco-eyebrow-sm">Evidence</h3>
        {detail.evidence.parse_warning ? (
          <div className="rounded-md border border-ochre/30 bg-ochre/10 p-2 font-mono text-xs text-on-surface">
            {detail.evidence.parse_warning}
          </div>
        ) : null}
        {detail.evidence.available && detail.evidence.value !== null ? (
          <pre className="max-h-52 overflow-auto rounded-md bg-surface-container p-3 font-mono text-xs text-on-surface">
            {JSON.stringify(detail.evidence.value, null, 2)}
          </pre>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant">No structured evidence is available for this row.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="myco-eyebrow-sm">Git provenance</h3>
        {detail.git_provenance.length > 0 ? (
          <div className="space-y-2">
            {detail.git_provenance.map((row) => (
              <div key={row.id} className="min-w-0 rounded-md border border-[var(--ghost-border)] p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-on-surface">
                  <span className="break-words">{row.capture_point}</span>
                  <span className="break-words text-on-surface-variant">{formatEpoch(row.captured_at)}</span>
                  {row.branch ? <span className="break-all">{row.branch}</span> : null}
                </div>
                <div className="mt-2 grid min-w-0 gap-2 font-mono text-xs text-on-surface-variant sm:grid-cols-2">
                  <InlineDatum label="head" value={row.head_sha ?? 'unknown'} />
                  <InlineDatum label="upstream" value={row.upstream_ref ?? 'none'} />
                  <InlineDatum label="production" value={row.production_ref ?? 'none'} />
                  <InlineDatum
                    label="dirty"
                    value={`${row.is_dirty ? 'yes' : 'no'} (${row.staged_count}/${row.unstaged_count}/${row.untracked_count})`}
                  />
                </div>
                {row.changed_paths.length > 0 ? (
                  <CodeList label="changed_paths" values={row.changed_paths} />
                ) : null}
                {row.patch_ids.length > 0 ? (
                  <CodeList label="patch_ids" values={row.patch_ids.map(formatEvidenceValue)} />
                ) : null}
                {row.error ? (
                  <div className="mt-2 break-words rounded bg-terracotta/10 p-2 font-mono text-xs text-terracotta">
                    {row.error}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant">No raw Git provenance rows are available for this record.</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="myco-eyebrow-sm">Readiness</h3>
        <div className="grid min-w-0 gap-2 font-mono text-xs text-on-surface sm:grid-cols-2">
          <InlineDatum label="enabled" value={String(detail.readiness.enabled)} />
          <InlineDatum label="github repo" value={detail.readiness.github.repo_configured ? 'configured' : 'missing'} />
          <InlineDatum label="github token" value={detail.readiness.github.token_available ? 'available' : 'missing'} />
          <InlineDatum label="production refs" value={detail.readiness.production_refs.join(', ') || 'none'} />
          <InlineDatum label="integration refs" value={detail.readiness.integration_refs.join(', ') || 'none'} />
        </div>
        {detail.readiness.warnings.length > 0 ? (
          <ul className="space-y-1">
            {detail.readiness.warnings.map((warning) => (
              <li key={warning} className="break-words rounded bg-ochre/10 px-2 py-1 font-mono text-xs text-on-surface">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Link
        to={SETTINGS_LINK}
        className="inline-flex rounded-xs border border-[var(--ghost-border)] px-3 py-2 font-sans text-sm text-on-surface hover:bg-surface-container"
      >
        Release provenance settings
      </Link>
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: string; className?: string }): JSX.Element {
  return (
    <div className={cn('min-w-0 rounded-md bg-surface-container p-3', className)}>
      <div className="myco-eyebrow-sm">{label}</div>
      <div className="mt-1 break-all font-mono text-xs text-on-surface">{value}</div>
    </div>
  );
}

function InlineDatum({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="min-w-0 break-words">
      <span className="text-on-surface">{label}: </span>
      <span className="break-all">{value}</span>
    </span>
  );
}

function CodeList({ label, values }: { label: string; values: string[] }): JSX.Element {
  return (
    <div className="mt-2 min-w-0 rounded bg-surface-container/60 p-2 font-mono text-xs text-on-surface-variant">
      <div className="myco-eyebrow-sm">{label}</div>
      <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
        {values.map((value, index) => (
          <span
            key={`${label}-${index}-${value}`}
            className="min-w-0 max-w-full break-all rounded bg-surface-container-high px-1.5 py-0.5"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatEpoch(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return 'unknown';
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatEvidenceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
}

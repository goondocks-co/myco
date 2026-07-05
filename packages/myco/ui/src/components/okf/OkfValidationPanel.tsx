import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Button } from '../ui/button';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { SlideoutDetailPanel } from '../ui/slideout-detail-panel';
import type { OkfStatusResponse, useOkfMaintain } from '../../hooks/use-okf';

function validationTone(status: OkfStatusResponse): { label: string; tone: StatusTone } {
  if (!status.validation) return { label: 'Not validated', tone: 'outline' };
  return status.validation.ok ? { label: 'Valid', tone: 'sage' } : { label: 'Invalid', tone: 'terracotta' };
}

export interface OkfValidationPanelProps {
  status: OkfStatusResponse;
  maintain: ReturnType<typeof useOkfMaintain>;
}

/**
 * Validation summary + diagnostics slideout + the publish-acknowledgement
 * flow. There is no separate ack endpoint — acknowledging re-invokes
 * `useOkfMaintain` with `acknowledgePublish: true` (addendum decision;
 * matches the MCP surface, which also has no dedicated ack path).
 */
export function OkfValidationPanel({ status, maintain }: OkfValidationPanelProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const summary = validationTone(status);
  const findings = status.publishEligibility.findings;
  const blocked = !status.publishEligibility.ok;

  function acknowledgePublish() {
    maintain.mutate({ acknowledgePublish: true });
  }

  return (
    <Panel
      eyebrow="Validation"
      title="Validation & publish"
      actions={
        <Button variant="ghost" size="sm" onClick={() => setDetailOpen(true)}>
          View diagnostics
        </Button>
      }
    >
      <div className="flex items-center justify-between py-1">
        <span className="text-sm text-on-surface">Bundle validation</span>
        <div className="flex items-center gap-1.5">
          <StatusDot tone={summary.tone} />
          <span className="font-mono text-xs text-on-surface-variant">{summary.label}</span>
        </div>
      </div>

      {blocked && (
        <div
          className="mt-3 flex flex-col gap-2 rounded-md border border-ochre/30 bg-ochre/5 p-3"
          data-testid="okf-publish-eligibility-block"
        >
          <div className="flex items-center gap-1.5">
            <StatusDot tone="ochre" />
            <span className="text-sm font-medium text-on-surface">
              Publish blocked — {findings.length} finding{findings.length === 1 ? '' : 's'} need acknowledgement
            </span>
          </div>
          <p className="text-xs text-on-surface-variant">
            Review the findings below, then acknowledge to allow this bundle to be published to the repo.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={acknowledgePublish}
            disabled={maintain.isPending}
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            {maintain.isPending ? 'Acknowledging…' : 'Acknowledge & allow publish'}
          </Button>
        </div>
      )}

      {!blocked && status.publishEligibility.findings.length === 0 && (
        <p className="mt-2 text-xs text-on-surface-variant">No publish-eligibility findings.</p>
      )}

      <SlideoutDetailPanel
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        ariaLabel="OKF validation diagnostics"
        testIdRoot="okf-validation"
      >
        <div className="flex flex-col gap-1 mb-5">
          <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
            Diagnostics
          </div>
          <div className="text-base font-semibold text-on-surface">Validation & publish eligibility</div>
        </div>

        {status.validation && (
          <div className="mb-5 grid grid-cols-2 gap-3 text-sm">
            <div className="text-on-surface-variant">Level</div>
            <div className="text-on-surface">{status.validation.level}</div>
            <div className="text-on-surface-variant">Files checked</div>
            <div className="text-on-surface">{status.validation.filesChecked}</div>
            <div className="text-on-surface-variant">Concepts checked</div>
            <div className="text-on-surface">{status.validation.conceptsChecked}</div>
          </div>
        )}

        <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant mb-2">
          Publish-eligibility findings
        </div>
        {findings.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No findings.</p>
        ) : (
          <div className="flex flex-col divide-y divide-outline-variant/15">
            {findings.map((finding, idx) => (
              <div key={`${finding.code}-${idx}`} className="py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-ochre">{finding.code}</span>
                  <span className="font-mono text-[11px] text-on-surface-variant">{finding.path}</span>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant">{finding.excerpt}</p>
              </div>
            ))}
          </div>
        )}
      </SlideoutDetailPanel>
    </Panel>
  );
}

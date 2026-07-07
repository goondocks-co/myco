/**
 * OKF (Open Knowledge Format) page — knowledge-first: the primary content is
 * the OkfBrowser knowledge browser (Task 5.1), with a secondary Maintenance
 * strip below it (bundle status, Validate action, the publish-block, and
 * recent-run history). Discovery status (the AGENTS.md pointer) rounds out
 * the page.
 *
 * Capability enable, synthesis scope, output path, and the AGENTS.md
 * pointer toggle are configured on the Settings page (`/settings#okf`) as
 * project-tier ScopedFields — this page reads state, it doesn't own config.
 * (The Groves capability panel also has a quick OKF toggle that writes
 * Personal ('local') scope for fast opt-in; a user who disabled OKF locally
 * there stays disabled here at project scope until that override clears.)
 *
 * Maintenance is the async `okf-synthesize` scheduled task, not a
 * UI-triggered action — there is no "Maintain Now" button. "Reveal in
 * Finder" is intentionally dropped (Phase 1 deviation #4 — no reveal
 * endpoint exists) and one-shot export is deliberately not a UI action
 * (API/CLI-only). See OkfActionsPanel for the Validate/Copy-path actions and
 * the publish-block — a blocked synthesis run persists its findings so the
 * block is visible on a plain page load, and "Acknowledge & publish" drains
 * them via `POST /api/okf/acknowledge` so the next synthesis run publishes.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getAtPath } from '@myco/utils/dot-path';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { OkfStatusPanel } from '../components/okf/OkfStatusPanel';
import { OkfActionsPanel } from '../components/okf/OkfActionsPanel';
import { OkfDiscoveryPanel } from '../components/okf/OkfDiscoveryPanel';
import { OkfBrowser } from '../components/okf/OkfBrowser';
import { useOkfAcknowledge, useOkfStatus, useOkfValidate, useInvalidateOkfStatus } from '../hooks/use-okf';
import { useActiveProjectSelection } from '../hooks/use-project-selection';
import { useScopedConfig } from '../hooks/use-scoped-config';

export default function Okf() {
  const { data: status, isLoading, isError } = useOkfStatus();
  const { effective: config } = useScopedConfig();
  const invalidateOkfStatus = useInvalidateOkfStatus();
  const acknowledge = useOkfAcknowledge();
  const validate = useOkfValidate();
  const selection = useActiveProjectSelection();

  // Gate on the live merged config — Settings' Enable OKF field writes
  // `okf.enabled` through ScopedField, which invalidates the merged-config
  // query, so this flips reactively without a manual reload (the status
  // query's `enabled` field lags behind that write). Refetch status on the
  // transition so bundle metadata reflects the new state too.
  const configEnabled = getAtPath((config ?? {}) as Record<string, unknown>, 'okf.enabled') === true;
  useEffect(() => {
    invalidateOkfStatus();
  }, [configEnabled, invalidateOkfStatus]);

  const unresolved = isLoading || isError || !status;
  const enabled = !unresolved && configEnabled;

  return (
    <PageContainer>
      <PageHeader title="OKF" subtitle="Repository-carried Open Knowledge Format wiki" />

      {isLoading && (
        <Surface className="px-4 py-6 text-sm text-on-surface-variant">Loading OKF status…</Surface>
      )}

      {isError && !isLoading && (
        <Surface className="px-4 py-6 text-sm text-on-surface-variant" data-testid="okf-status-error">
          Couldn't load OKF status. Actions are disabled until this resolves.
        </Surface>
      )}

      {!unresolved && !enabled && (
        <Panel eyebrow="Opt-in" title="OKF is disabled for this project">
          <p className="text-sm text-on-surface-variant">
            OKF publishes a portable, repository-carried knowledge wiki any agent can read and
            maintain without Myco. Enable it and configure the synthesis scope on the{' '}
            <Link to="/settings#okf" className="text-primary hover:underline">
              Settings
            </Link>{' '}
            page.
          </p>
          {status?.bundleExists && (
            <p className="mt-2 text-xs text-on-surface-variant">
              A bundle already exists at <span className="font-mono">{status.outputPath}</span> from a
              previous run — re-enable to resume maintaining it.
            </p>
          )}
        </Panel>
      )}

      {!unresolved && enabled && (
        <>
          <Panel eyebrow="Bundle" title="Knowledge" padded={false}>
            <div className="px-5 py-4">
              <OkfBrowser />
            </div>
          </Panel>

          <div className="space-y-3">
            <SectionHeader>Maintenance</SectionHeader>
            <OkfStatusPanel status={status} />
            <OkfActionsPanel status={status} acknowledge={acknowledge} validate={validate} />

            <Panel eyebrow="History" title="Recent maintenance">
              {status.lastRun ? (
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-on-surface">{status.lastRun.status}</span>
                  <span className="font-mono text-xs text-on-surface-variant">
                    {status.lastRun.finishedAt ?? '—'}
                  </span>
                </div>
              ) : selection ? (
                <p className="text-sm text-on-surface-variant">
                  No maintenance runs recorded yet. Scheduled runs will appear on the{' '}
                  <Link to={`/g/${selection.grove.slug}/operations`} className="text-primary hover:underline">
                    Operations
                  </Link>{' '}
                  page once the okf-synthesize task runs.
                </p>
              ) : (
                <p className="text-sm text-on-surface-variant">
                  No maintenance runs recorded yet.
                </p>
              )}
            </Panel>
          </div>

          <OkfDiscoveryPanel status={status} />
        </>
      )}
    </PageContainer>
  );
}

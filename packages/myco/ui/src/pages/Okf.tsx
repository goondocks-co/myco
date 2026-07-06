/**
 * OKF (Open Knowledge Format) page — owns the whole OKF workflow for the
 * active project: enable opt-in, status, actions (maintain/validate/copy
 * path), sources, agent discovery, validation + publish-acknowledgement,
 * recent maintenance, and advanced (include-set/output-path) settings.
 *
 * "Reveal in Finder" is intentionally dropped (Phase 1 deviation #4 — no
 * reveal endpoint exists) and one-shot export is deliberately not a UI
 * action (API/CLI-only). See OkfActionsPanel for the action surface.
 *
 * The enable toggle and every advanced setting write through `ScopedField`,
 * which resolves `okf.*` to its registry home tier (project, with a
 * Personal override) — never a bespoke config mutation path. This is
 * intentionally different from the Groves CapabilityPanel's quick toggle,
 * which always writes Personal ('local') scope; a user who disabled OKF
 * locally in Groves and enables it here at project scope stays disabled
 * until the Personal override is cleared — the ScopePill on this page's
 * ScopedField surfaces that override the same way every other Settings
 * field does.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAtPath } from '@myco/utils/dot-path';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { Surface } from '../components/ui/surface';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { SlideoutDetailPanel } from '../components/ui/slideout-detail-panel';
import { ScopedField } from '../components/config/ScopedField';
import { OkfStatusPanel } from '../components/okf/OkfStatusPanel';
import { OkfActionsPanel } from '../components/okf/OkfActionsPanel';
import { OkfSourcesPanel } from '../components/okf/OkfSourcesPanel';
import { OkfDiscoveryPanel } from '../components/okf/OkfDiscoveryPanel';
import { OkfValidationPanel } from '../components/okf/OkfValidationPanel';
import { useOkfMaintain, useOkfStatus, useOkfValidate, useInvalidateOkfStatus } from '../hooks/use-okf';
import { useActiveProjectSelection } from '../hooks/use-project-selection';
import { useScopedConfig } from '../hooks/use-scoped-config';

export default function Okf() {
  const { data: status, isLoading, isError } = useOkfStatus();
  const { effective: config } = useScopedConfig();
  const invalidateOkfStatus = useInvalidateOkfStatus();
  const maintain = useOkfMaintain();
  const validate = useOkfValidate();
  const selection = useActiveProjectSelection();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Gate on the live merged config — the enable switch writes `okf.enabled`
  // through ScopedField, which invalidates the merged-config query, so this
  // flips reactively without a manual reload (the status query's `enabled`
  // field lags behind that write). Refetch status on the transition so bundle
  // metadata reflects the new state too.
  const configEnabled = getAtPath((config ?? {}) as Record<string, unknown>, 'okf.enabled') === true;
  useEffect(() => {
    invalidateOkfStatus();
  }, [configEnabled, invalidateOkfStatus]);

  const unresolved = isLoading || isError || !status;
  const enabled = !unresolved && configEnabled;

  return (
    <PageContainer>
      <PageHeader
        title="OKF"
        subtitle="Repository-carried Open Knowledge Format bundle"
        actions={
          !unresolved && !enabled ? (
            <ScopedField<string, boolean> path="okf.enabled" label="Enable OKF">
              {({ value, onChange }) => (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-on-surface-variant">Enable OKF</span>
                  <Switch checked={value ?? false} onCheckedChange={onChange} />
                </div>
              )}
            </ScopedField>
          ) : undefined
          // When enabled, Maintain/Validate live exclusively in
          // OkfActionsPanel below — the header doesn't duplicate them.
        }
      />

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
            Turn on OKF to generate a repository-carried knowledge bundle from this project's
            spores, canopy entries, and concepts. Existing bundles (if any) remain readable below
            once enabled.
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
          <OkfStatusPanel status={status} />
          <OkfActionsPanel status={status} maintain={maintain} validate={validate} />
          <OkfSourcesPanel status={status} />
          <OkfDiscoveryPanel status={status} />
          <OkfValidationPanel status={status} maintain={maintain} />

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
                page once the okf-maintain task runs.
              </p>
            ) : (
              <p className="text-sm text-on-surface-variant">
                No maintenance runs recorded yet.
              </p>
            )}
          </Panel>

          <div>
            <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen(true)}>
              Advanced options
            </Button>
          </div>

          <SlideoutDetailPanel
            open={advancedOpen}
            onClose={() => setAdvancedOpen(false)}
            ariaLabel="OKF advanced options"
            testIdRoot="okf-advanced"
          >
            <div className="flex flex-col gap-1 mb-5">
              <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
                Advanced
              </div>
              <div className="text-base font-semibold text-on-surface">Include sets & output path</div>
            </div>

            <div className="flex flex-col gap-4">
              <ScopedField<string, boolean> path="okf.maintain.include.spores" label="Include spores">
                {({ value, onChange }) => (
                  <Switch checked={value ?? true} onCheckedChange={onChange} />
                )}
              </ScopedField>
              <ScopedField<string, boolean> path="okf.maintain.include.canopy" label="Include canopy">
                {({ value, onChange }) => (
                  <Switch checked={value ?? true} onCheckedChange={onChange} />
                )}
              </ScopedField>
              <ScopedField<string, boolean> path="okf.maintain.include.concepts" label="Include concepts">
                {({ value, onChange }) => (
                  <Switch checked={value ?? true} onCheckedChange={onChange} />
                )}
              </ScopedField>
              <ScopedField<string, boolean> path="okf.maintain.include.guides" label="Include guides">
                {({ value, onChange }) => (
                  <Switch checked={value ?? true} onCheckedChange={onChange} />
                )}
              </ScopedField>
              <ScopedField<string, string> path="okf.maintain.output_path" label="Output path" commitOn="blur">
                {({ value, onChange, onBlur }) => (
                  <Input
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={onBlur}
                    className="font-mono text-xs"
                  />
                )}
              </ScopedField>
            </div>
          </SlideoutDetailPanel>
        </>
      )}
    </PageContainer>
  );
}

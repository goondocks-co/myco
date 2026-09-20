import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { BackupPanel } from '../components/operations/BackupPanel';
import { RecoveryPanel } from '../components/operations/RecoveryPanel';
import { WakePanel } from '../components/operations/WakePanel';
import { TitlingBackfillPanel } from '../components/operations/TitlingBackfillPanel';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

/** `/operations`: the operator's page. What this server can do for you today, and what arrives with the backup and observability work. */
export function Operations() {
  return (
    <PageContainer>
      <PageHeader title="Operations" subtitle="Backups, diagnostics and what this server reports about itself." />
      <div className="flex flex-col gap-4">
        <Panel title="Health" eyebrow="Now">
          <p className="font-sans text-sm text-on-surface-variant">
            Schema, configured capabilities and what each project last sent are on <Link to="/status" className="text-primary underline">Status</Link>.
          </p>
        </Panel>
        <WakePanel />
        <TitlingBackfillPanel />
        <BackupPanel />
        <RecoveryPanel />
        <Panel title="Diagnostics" data-testid="diagnostics">
          <p className="font-sans text-sm text-on-surface-variant">
            One file describing this server: its schema, what it is configured to run, the workers attached to it, the runs
            waiting, and what each project last sent. Attach it to an issue.
          </p>
          <p className="mt-2 font-sans text-xs text-on-surface-variant">
            It carries no keys, no captured content and no error messages — every failure is named rather than quoted. On your
            own machine, <code className="font-mono">myco member export</code> writes the matching half.
          </p>
          <a className={`${button} mt-3 inline-block`} href="/api/diagnostics" download data-testid="download-diagnostics">
            Download
          </a>
        </Panel>
      </div>
    </PageContainer>
  );
}

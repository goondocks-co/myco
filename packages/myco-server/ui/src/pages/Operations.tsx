import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { BackupPanel } from '../components/operations/BackupPanel';
import { WakePanel } from '../components/operations/WakePanel';

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
        <BackupPanel />
        <Panel title="Diagnostics" eyebrow="Pending" tone="ochre" data-testid="pending-diagnostics">
          <p className="font-sans text-sm text-on-surface-variant">
            A diagnostics export arrives with the observability work. Today the facts on Status are what this server reports.
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}

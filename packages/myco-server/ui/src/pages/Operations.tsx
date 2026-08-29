import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';

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
        <Panel title="Backup" eyebrow="Pending" tone="ochre" data-testid="pending-backup">
          <p className="font-sans text-sm text-on-surface-variant">
            Backup visibility arrives with the backup work. Until then, back up the store with your platform's tools: the database file on the volume for a self-hosted server, or an export of the hosted database.
          </p>
        </Panel>
        <Panel title="Diagnostics" eyebrow="Pending" tone="ochre" data-testid="pending-diagnostics">
          <p className="font-sans text-sm text-on-surface-variant">
            A diagnostics export arrives with the observability work. Today the facts on Status are what this server reports.
          </p>
        </Panel>
      </div>
    </PageContainer>
  );
}

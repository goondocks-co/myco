import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';

/** `/notifications`: nothing is recorded on the server yet; the page says so rather than showing an empty list. */
export function Notifications() {
  return (
    <PageContainer>
      <PageHeader title="Notifications" subtitle="What this server wants you to know." />
      <Panel title="Nothing recorded yet" eyebrow="Pending" tone="ochre" data-testid="pending-notifications">
        <p className="font-sans text-sm text-on-surface-variant">
          Notifications arrive with the observability work. How long they are kept is set under <Link to="/settings" className="text-primary underline">Settings · Records</Link>.
        </p>
      </Panel>
    </PageContainer>
  );
}

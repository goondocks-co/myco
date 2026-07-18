import { PageHeader } from '../../components/ui/page-header';
import { PageContainer } from '../../components/ui/page-container';
import { HostTab } from './HostTab';

export function TeamPage() {
  return (
    <PageContainer>
      <PageHeader title="Team" subtitle="Route projects to a shared Team Host" />
      <HostTab />
    </PageContainer>
  );
}

export default TeamPage;

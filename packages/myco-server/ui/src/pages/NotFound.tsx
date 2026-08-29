import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';

export function NotFound() {
  return (
    <PageContainer variant="narrow">
      <PageHeader title="Not found" subtitle="There is nothing at this address." />
      <Link to="/projects" className="font-sans text-sm text-primary underline-offset-2 hover:underline">
        Back to Projects
      </Link>
    </PageContainer>
  );
}

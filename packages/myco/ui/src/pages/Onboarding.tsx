import { Terminal } from 'lucide-react';
import { PageContainer } from '../components/ui/page-container';

export default function Onboarding() {
  return (
    <PageContainer variant="narrow" className="min-h-full justify-center">
      <div className="flex flex-col gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Terminal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-on-surface">Initialize a project</h1>
          <p className="mt-2 max-w-xl text-sm text-on-surface-variant">
            This daemon has no registered Grove projects yet. Initialize a repository from its project directory to make it available here.
          </p>
        </div>
        <pre className="overflow-x-auto rounded-md border border-outline-variant/30 bg-surface-container p-4 text-sm text-on-surface">
          <code>myco init</code>
        </pre>
      </div>
    </PageContainer>
  );
}

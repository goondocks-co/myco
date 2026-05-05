import { Terminal } from 'lucide-react';

export default function Onboarding() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-6 py-12">
      <div className="space-y-4">
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
    </div>
  );
}

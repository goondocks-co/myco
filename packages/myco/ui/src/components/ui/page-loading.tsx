import { Loader2, AlertCircle } from 'lucide-react';

interface PageLoadingProps {
  isLoading: boolean;
  error: Error | null;
  loadingText?: string;
  children: React.ReactNode;
}

export function PageLoading({ isLoading, error, loadingText = 'Loading...', children }: PageLoadingProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans text-sm">{loadingText}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-tertiary">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Failed to connect to daemon</span>
        <span className="font-sans text-xs text-on-surface-variant">{error.message}</span>
      </div>
    );
  }

  return <>{children}</>;
}

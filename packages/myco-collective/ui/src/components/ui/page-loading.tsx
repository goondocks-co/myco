import { AlertCircle, Loader2 } from 'lucide-react';

interface PageLoadingProps {
  isLoading: boolean;
  error: Error | null;
  loadingText?: string;
  children: React.ReactNode;
}

export function PageLoading({
  isLoading,
  error,
  loadingText = 'Loading...',
  children,
}: PageLoadingProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-3 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">{loadingText}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="h-5 w-5 text-tertiary" />
        <span className="text-sm text-on-surface">Unable to load this view</span>
        <span className="max-w-md text-xs text-on-surface-variant">{error.message}</span>
      </div>
    );
  }

  return <>{children}</>;
}

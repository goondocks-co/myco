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
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>{loadingText}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span>Failed to connect to daemon</span>
        <span className="text-xs text-muted-foreground">{error.message}</span>
      </div>
    );
  }

  return <>{children}</>;
}

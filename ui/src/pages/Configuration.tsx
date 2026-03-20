import { RefreshCw, Settings, AlertCircle } from 'lucide-react';
import { useConfig } from '../hooks/use-config';
import { ConfigForm } from '../components/config/ConfigForm';

export default function Configuration() {
  const { config, isLoading, error, saveConfig, isSaving } = useConfig();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-6 w-6 animate-spin" />
          <span className="text-sm">Loading configuration...</span>
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <AlertCircle className="h-6 w-6 opacity-50" />
          <span className="text-sm">Unable to load configuration</span>
          <span className="text-xs opacity-60">
            {error instanceof Error ? error.message : 'Check that the daemon is running'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <Settings className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Configuration</h1>
      </div>
      <ConfigForm config={config} onSave={saveConfig} isSaving={isSaving} />
    </div>
  );
}

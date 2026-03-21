import { Settings } from 'lucide-react';
import { useConfig } from '../hooks/use-config';
import { ConfigForm } from '../components/config/ConfigForm';
import { PageLoading } from '../components/ui/page-loading';

export default function Configuration() {
  const { config, isLoading, error, saveConfig, isSaving } = useConfig();

  return (
    <PageLoading
      isLoading={isLoading}
      error={error}
      loadingText="Loading configuration..."
    >
      {config && (
        <div className="flex flex-col gap-6 p-6">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Configuration</h1>
          </div>
          <ConfigForm config={config} onSave={saveConfig} isSaving={isSaving} />
        </div>
      )}
    </PageLoading>
  );
}

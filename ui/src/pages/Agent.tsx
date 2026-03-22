import { useState } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../components/ui/button';
import { RunList } from '../components/agent/RunList';
import { RunDetail } from '../components/agent/RunDetail';
import { TriggerRun } from '../components/agent/TriggerRun';

export default function Agent() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [triggerOpen, setTriggerOpen] = useState(false);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Curation history — what Myco observed, decided, and wrote
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setTriggerOpen(true)}
        >
          <Play className="h-3.5 w-3.5" />
          Run Now
        </Button>
      </div>

      {selectedRunId ? (
        <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(undefined)} />
      ) : (
        <RunList onSelectRun={setSelectedRunId} onTriggerRun={() => setTriggerOpen(true)} />
      )}

      <TriggerRun
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTriggered={() => setSelectedRunId(undefined)}
      />
    </div>
  );
}

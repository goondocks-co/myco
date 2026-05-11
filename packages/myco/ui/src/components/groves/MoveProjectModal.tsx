import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import type { GroveSummary } from '../../lib/selection';
import { useMoveProject } from '../../hooks/use-grove-mutations';
import { showToast } from './toast';

interface MoveProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceGroveId: string;
  projectId: string;
  projectName: string;
  /** All groves; the source Grove is filtered out by this component. */
  groves: GroveSummary[];
}

export function MoveProjectModal({
  open,
  onOpenChange,
  sourceGroveId,
  projectId,
  projectName,
  groves,
}: MoveProjectModalProps) {
  const candidates = groves.filter((g) => g.id !== sourceGroveId);
  const [targetGroveId, setTargetGroveId] = useState<string>(candidates[0]?.id ?? '');
  const moveProject = useMoveProject();

  useEffect(() => {
    if (open) {
      setTargetGroveId(candidates[0]?.id ?? '');
      moveProject.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceGroveId, projectId]);

  function handleConfirm() {
    if (!targetGroveId) return;
    moveProject.mutate(
      { targetGroveId, projectId },
      {
        onSuccess: () => {
          showToast({ level: 'success', title: 'Project moved' });
          onOpenChange(false);
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Move failed', detail: err.message });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move project</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium text-on-surface">{projectName}</span> to another Grove.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No other Groves available. Create a new Grove first.
          </p>
        ) : (
          <div className="space-y-2">
            <label htmlFor="move-target-grove" className="text-sm font-medium text-on-surface">
              Destination Grove
            </label>
            <select
              id="move-target-grove"
              value={targetGroveId}
              onChange={(e) => setTargetGroveId(e.target.value)}
              disabled={moveProject.isPending}
              className="w-full rounded-md border border-outline-variant/40 bg-surface-container-low px-3 py-1.5 text-sm text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {candidates.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            {/*
              Preview pane (per-table row counts) is deferred to a follow-up
              that will add `POST /api/groves/:id/projects/:projectId/move-preview`.
              For now we simply confirm the move.
            */}
            <p className="text-xs text-on-surface-variant">
              The project keeps its data; only its Grove binding changes.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={moveProject.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            disabled={moveProject.isPending || candidates.length === 0 || !targetGroveId}
            className="gap-2"
          >
            {moveProject.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {moveProject.isPending ? 'Moving…' : 'Confirm move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

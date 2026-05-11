import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useDeleteGrove } from '../../hooks/use-grove-mutations';
import { ApiError } from '../../lib/api';
import { showToast } from './toast';

interface DeleteGroveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groveId: string;
  groveName: string;
  projectCount: number;
}

export function DeleteGroveModal({
  open,
  onOpenChange,
  groveId,
  groveName,
  projectCount,
}: DeleteGroveModalProps) {
  const deleteGrove = useDeleteGrove();
  const hasProjects = projectCount > 0;

  function handleConfirm() {
    if (hasProjects) return;
    deleteGrove.mutate(
      { id: groveId },
      {
        onSuccess: () => {
          showToast({ level: 'success', title: 'Grove deleted', detail: groveName });
          onOpenChange(false);
        },
        onError: (err) => {
          // 409 envelope: { error, project_count }
          if (err instanceof ApiError && err.status === 409) {
            const body = err.body as { project_count?: number } | null;
            const count = body?.project_count ?? '?';
            showToast({
              level: 'error',
              title: 'Grove not empty',
              detail: `${count} project(s) still bound`,
            });
          } else {
            showToast({ level: 'error', title: 'Delete failed', detail: err.message });
          }
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Grove</DialogTitle>
          <DialogDescription>
            Delete <span className="font-medium text-on-surface">{groveName}</span>?
            This removes the Grove from the local registry.
          </DialogDescription>
        </DialogHeader>
        {hasProjects && (
          <p className="rounded-md border border-tertiary/30 bg-tertiary/10 px-3 py-2 text-sm text-on-surface">
            Move or remove the {projectCount} project{projectCount === 1 ? '' : 's'} in this Grove first.
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={deleteGrove.isPending}
          >
            Cancel
          </Button>
          <span title={hasProjects ? 'Grove still has projects' : undefined}>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleConfirm}
              disabled={deleteGrove.isPending || hasProjects}
            >
              {deleteGrove.isPending ? 'Deleting…' : 'Delete Grove'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

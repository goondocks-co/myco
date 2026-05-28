import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useDeleteProject } from '../../hooks/use-grove-mutations';
import { showToast } from './toast';

interface DeleteProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groveId: string;
  projectId: string;
  projectName: string;
}

export function DeleteProjectModal({
  open,
  onOpenChange,
  groveId,
  projectId,
  projectName,
}: DeleteProjectModalProps) {
  const [confirmation, setConfirmation] = useState('');
  const deleteProject = useDeleteProject();
  const confirmed = confirmation === projectName;

  function handleConfirm() {
    if (!confirmed) return;
    deleteProject.mutate(
      { groveId, projectId, confirmationName: confirmation },
      {
        onSuccess: (data) => {
          showToast({
            level: 'success',
            title: 'Project deleted',
            detail: data.delete.snapshot_path,
          });
          setConfirmation('');
          onOpenChange(false);
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Delete failed', detail: err.message });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Project Permanently</DialogTitle>
          <DialogDescription>
            This deletes <span className="font-medium text-on-surface">{projectName}</span> from its Grove and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm text-on-surface-variant">
            Type <span className="font-mono text-on-surface">{projectName}</span> to confirm.
          </p>
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            aria-label="Project name confirmation"
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={deleteProject.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleConfirm}
            disabled={deleteProject.isPending || !confirmed}
          >
            {deleteProject.isPending ? 'Deleting…' : 'Delete Permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

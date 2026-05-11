import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useRenameGrove } from '../../hooks/use-grove-mutations';
import { showToast } from './toast';

interface RenameGroveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groveId: string;
  currentName: string;
}

export function RenameGroveModal({ open, onOpenChange, groveId, currentName }: RenameGroveModalProps) {
  const [name, setName] = useState(currentName);
  const renameGrove = useRenameGrove();

  useEffect(() => {
    if (open) {
      setName(currentName);
      renameGrove.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentName]);

  const trimmed = name.trim();
  const unchanged = trimmed === currentName;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length === 0 || unchanged) return;
    renameGrove.mutate(
      { id: groveId, name: trimmed },
      {
        onSuccess: () => {
          showToast({ level: 'success', title: 'Grove renamed' });
          onOpenChange(false);
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Rename failed', detail: err.message });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename Grove</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="rename-grove-name" className="text-sm font-medium text-on-surface">
              Name
            </label>
            <input
              id="rename-grove-name"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-outline-variant/40 bg-surface-container-low px-3 py-1.5 text-sm text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <p className="text-xs text-on-surface-variant">
              The Grove slug may change if the new name slugifies differently. Auto-suffixes on collision.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={renameGrove.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={renameGrove.isPending || trimmed.length === 0 || unchanged}
            >
              {renameGrove.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useCreateGrove } from '../../hooks/use-grove-mutations';
import { slugifyGroveNamePreview } from './slug';
import { showToast } from './toast';

interface NewGroveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewGroveModal({ open, onOpenChange }: NewGroveModalProps) {
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const createGrove = useCreateGrove();

  useEffect(() => {
    if (open) {
      setName('');
      setFormError(null);
      createGrove.reset();
    }
    // createGrove ref is stable from react-query; intentional dep narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const slugPreview = trimmed.length > 0 ? slugifyGroveNamePreview(trimmed) : '';

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length === 0) {
      setFormError('Name is required.');
      return;
    }
    setFormError(null);
    createGrove.mutate(
      { name: trimmed },
      {
        onSuccess: (data) => {
          showToast({ level: 'success', title: 'Grove created', detail: data.slug });
          onOpenChange(false);
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Could not create Grove', detail: err.message });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Grove</DialogTitle>
          <DialogDescription>Group projects into a local Grove.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="new-grove-name" className="text-sm font-medium text-on-surface">
              Name
            </label>
            <input
              id="new-grove-name"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="Personal"
              className="w-full rounded-md border border-outline-variant/40 bg-surface-container-low px-3 py-1.5 text-sm text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            {slugPreview && (
              <p className="font-mono text-xs text-on-surface-variant">
                slug: {slugPreview}
              </p>
            )}
            {formError && (
              <p className="text-xs text-tertiary">{formError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={createGrove.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={createGrove.isPending || trimmed.length === 0}
            >
              {createGrove.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

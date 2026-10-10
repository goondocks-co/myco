import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, Input } from '../../../design';
import { refusalText } from '../../../hooks/use-access';
import { useProjectActions } from '../../../hooks/use-projects';
import type { ProjectSummary } from '../../../lib/api';

/** One input and one action: the name a project shows everywhere it is listed. */
export function RenameProjectDialog({ project, onClose }: {
  project: Pick<ProjectSummary, 'projectId' | 'name'> | null;
  onClose: () => void;
}) {
  const { rename } = useProjectActions();
  const pending = rename.isPending;
  const error = rename.error ? refusalText(rename.error) : null;
  const close = () => { onClose(); rename.reset(); };
  const onRename = (name: string) => {
    if (project) rename.mutate({ projectId: project.projectId, name }, { onSuccess: onClose });
  };
  const [name, setName] = useState('');
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (project !== null && openedFor !== project.projectId) { setOpenedFor(project.projectId); setName(project.name); }
  if (project === null && openedFor !== null) setOpenedFor(null);
  const trimmed = name.trim();
  return (
    <Dialog open={project !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent title={`Rename ${project?.name ?? ''}`} description="The new name shows everywhere this project is listed.">
        <form className="flex flex-col gap-s3" onSubmit={(e) => { e.preventDefault(); if (trimmed !== '' && !pending) onRename(trimmed); }}>
          <label className="flex flex-col gap-s1 t-small text-muted" htmlFor="project-rename">
            Name
            <Input id="project-rename" value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={trimmed === ''} pending={pending}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Button, Dialog, DialogContent, DialogFooter, Input } from '../../../design';
import { useAccessActions } from '../../../hooks/use-access';
import { machineNameProblem, renameRefusalWords } from './rename';

/** The machine a rename is for: its id, the name it shows, and whether that name is its own or a stand-in. */
export interface RenameTarget {
  id: string;
  name: string;
  named: boolean;
}

/**
 * Rename a machine: its name prefilled, checked as it is typed against the rule
 * the server holds it to, and the server's refusal said in words. Its member
 * sees the name beside their own work; admins see it on People & machines and
 * Health; everyone else sees the work as from its member.
 */
export function RenameMachineDialog({ machine, onClose }: { machine: RenameTarget | null; onClose: () => void }) {
  return (
    <Dialog open={machine !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {machine !== null && <RenameBody key={machine.id} machine={machine} onClose={onClose} />}
    </Dialog>
  );
}

function RenameBody({ machine, onClose }: { machine: RenameTarget; onClose: () => void }) {
  const rename = useAccessActions().renameMachine;
  const current = machine.named ? machine.name : '';
  const [draft, setDraft] = useState(current);
  const problem = machineNameProblem(draft);
  const unchanged = draft.trim() === current;
  // An empty field says why only once something was typed, so the dialog does not open on a complaint.
  const shown = problem !== null && (draft !== '' || current !== '') ? problem : null;
  const save = () => {
    if (problem !== null || unchanged || rename.isPending) return;
    rename.mutate({ machineId: machine.id, name: draft.trim() }, { onSuccess: onClose });
  };

  return (
    <DialogContent
      title={machine.named ? `Rename ${machine.name}` : 'Name this machine'}
      description={`Its member sees this name beside their own work, and admins see it on ${INVITE_CONTROLS.page} and Health. Everyone else sees the work as from its member.`}
    >
      <form className="flex flex-col gap-s3" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Input
          aria-label="Machine name"
          autoFocus
          value={draft}
          aria-invalid={shown !== null}
          onChange={(event) => { setDraft(event.target.value); rename.reset(); }}
        />
        {shown !== null && <p role="alert" className="t-small text-bad">{shown}</p>}
        {rename.error != null && <p role="alert" className="t-small text-bad">{renameRefusalWords(rename.error)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={problem !== null || unchanged} pending={rename.isPending}>Rename</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

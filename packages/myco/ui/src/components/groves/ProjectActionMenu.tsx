import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface ProjectActionMenuProps {
  projectName: string;
  onMove: () => void;
  onOpen: () => void;
  onBackup: () => void;
  backupPending?: boolean;
}

export function ProjectActionMenu({
  projectName,
  onMove,
  onOpen,
  onBackup,
  backupPending,
}: ProjectActionMenuProps) {
  const items: MenuItem[] = [
    { key: 'open', label: 'Open dashboard', onSelect: onOpen },
    { key: 'move', label: 'Move to another Grove', onSelect: onMove },
    {
      key: 'backup',
      label: backupPending ? 'Backing up…' : 'Back up this project',
      onSelect: onBackup,
      disabled: backupPending,
    },
  ];
  return <DropdownMenu items={items} ariaLabel={`${projectName} actions`} />;
}

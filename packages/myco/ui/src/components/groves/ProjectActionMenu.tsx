import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface ProjectActionMenuProps {
  projectName: string;
  archived?: boolean;
  onMove: () => void;
  onOpen: () => void;
  onBackup: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onIgnore: () => void;
  backupPending?: boolean;
}

export function ProjectActionMenu({
  projectName,
  archived = false,
  onMove,
  onOpen,
  onBackup,
  onArchive,
  onUnarchive,
  onDelete,
  onIgnore,
  backupPending,
}: ProjectActionMenuProps) {
  const items: MenuItem[] = [
    { key: 'open', label: 'Open dashboard', onSelect: onOpen, disabled: archived },
    { key: 'move', label: 'Move to another Grove', onSelect: onMove, disabled: archived },
    {
      key: 'backup',
      label: backupPending ? 'Backing up…' : 'Back up this project',
      onSelect: onBackup,
      disabled: backupPending,
    },
    { key: 'ignore', label: 'Ignore project…', onSelect: onIgnore, disabled: archived },
    archived
      ? { key: 'unarchive', label: 'Unarchive project', onSelect: onUnarchive }
      : { key: 'archive', label: 'Archive project', onSelect: onArchive },
    { key: 'delete', label: 'Delete permanently…', onSelect: onDelete, destructive: true },
  ];
  return <DropdownMenu items={items} ariaLabel={`${projectName} actions`} />;
}

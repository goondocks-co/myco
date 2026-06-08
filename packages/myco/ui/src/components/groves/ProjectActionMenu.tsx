import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface ProjectActionMenuProps {
  projectName: string;
  archived?: boolean;
  onMove: () => void;
  onOpen: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  onIgnore: () => void;
}

export function ProjectActionMenu({
  projectName,
  archived = false,
  onMove,
  onOpen,
  onArchive,
  onUnarchive,
  onDelete,
  onIgnore,
}: ProjectActionMenuProps) {
  const items: MenuItem[] = [
    { key: 'open', label: 'Open dashboard', onSelect: onOpen, disabled: archived },
    { key: 'move', label: 'Move to another Grove', onSelect: onMove, disabled: archived },
    { key: 'ignore', label: 'Ignore project…', onSelect: onIgnore, disabled: archived },
    archived
      ? { key: 'unarchive', label: 'Unarchive project', onSelect: onUnarchive }
      : { key: 'archive', label: 'Archive project', onSelect: onArchive },
    { key: 'delete', label: 'Delete permanently…', onSelect: onDelete, destructive: true },
  ];
  return <DropdownMenu items={items} ariaLabel={`${projectName} actions`} />;
}

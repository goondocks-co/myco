import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface GroveActionMenuProps {
  groveName: string;
  projectCount: number;
  onRename: () => void;
  onDelete: () => void;
}

export function GroveActionMenu({ groveName, projectCount, onRename, onDelete }: GroveActionMenuProps) {
  const hasProjects = projectCount > 0;
  const items: MenuItem[] = [
    { key: 'rename', label: 'Rename', onSelect: onRename },
    {
      key: 'delete',
      label: 'Delete Grove',
      destructive: true,
      disabled: hasProjects,
      disabledReason: hasProjects ? 'Move or remove projects first' : undefined,
      onSelect: onDelete,
    },
  ];
  return <DropdownMenu items={items} ariaLabel={`${groveName} actions`} />;
}

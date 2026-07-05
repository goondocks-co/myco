import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface GroveActionMenuProps {
  groveName: string;
  projectCount: number;
  isDefault: boolean;
  onRename: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}

export function GroveActionMenu({
  groveName,
  projectCount,
  isDefault,
  onRename,
  onDelete,
  onSetDefault,
}: GroveActionMenuProps) {
  const hasProjects = projectCount > 0;
  const items: MenuItem[] = [
    {
      key: 'set-default',
      label: 'Set as default',
      disabled: isDefault,
      disabledReason: isDefault ? 'Already the default Grove' : undefined,
      onSelect: onSetDefault,
    },
    { key: 'rename', label: 'Rename', onSelect: onRename },
    {
      key: 'delete',
      label: 'Delete Grove',
      destructive: true,
      disabled: isDefault || hasProjects,
      disabledReason: isDefault
        ? "The default Grove can't be deleted — set another Grove as default first"
        : hasProjects
          ? 'Move or remove projects first'
          : undefined,
      onSelect: onDelete,
    },
  ];
  return <DropdownMenu items={items} ariaLabel={`${groveName} actions`} />;
}

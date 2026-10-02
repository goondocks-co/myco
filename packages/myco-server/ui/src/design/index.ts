/**
 * The dashboard's design system: the one import path a page uses for its
 * controls and patterns. Tokens and the type scale live in `tokens.css`; the
 * accent themes in `themes.css`.
 */
export { Button, IconButton, buttonVariants, type ButtonProps, type IconButtonProps } from './primitives/Button';
export { Input, Textarea, SearchInput, type InputProps, type TextareaProps, type SearchInputProps } from './primitives/Input';
export {
  Select, SelectRoot, SelectTrigger, SelectContent, SelectItem, SelectValue, SelectGroup, SEARCHABLE_AFTER,
  type SelectProps, type SelectOption,
} from './primitives/Select';
export { SearchableSelect, searchableSelectRank, type SearchableSelectProps, type SearchableSelectOption } from './primitives/SearchableSelect';
export { Switch, type SwitchProps } from './primitives/Switch';
export { Tabs, TabsList, TabsTrigger, TabsContent, TabLinks, type TabsTriggerProps, type TabLinkItem } from './primitives/Tabs';
export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogFooter, ConfirmDialog, type DialogContentProps, type ConfirmDialogProps } from './primitives/Dialog';
export { MoreMenu, MenuItem, ActionMenu, type MoreMenuItem, type MoreMenuProps, type ActionMenuItem, type ActionMenuProps } from './primitives/MoreMenu';
export { Disclosure, type DisclosureProps } from './primitives/Disclosure';
export { Link, ActionLink, ItemLink, ExternalLink, type LinkProps, type ItemLinkProps, type ExternalLinkProps } from './primitives/Link';
export { StatusChip, TypeChip, Kbd, type Tone, type StatusChipProps, type TypeChipProps } from './primitives/Chip';
export { HealthDot, type HealthTone, type HealthDotProps } from './primitives/HealthDot';
export { Avatar, initialsOf, type AvatarProps } from './primitives/Avatar';
export { Card, type CardProps } from './primitives/Card';
export { Sparkline, type SparklineProps } from './primitives/Sparkline';
export { CopyButton, type CopyButtonProps } from './primitives/CopyButton';
export { Lightbox, type LightboxProps } from './primitives/Lightbox';
export { Progress, type ProgressProps } from './primitives/Progress';

export {
  FilterBar, useFilterParams, useQueryDraft, ANY, FIXED_WIDTH_FILTERS, type FilterBarProps, type FilterDefinition, type FilterParams, type FilterParamsOptions, type QueryDraft,
} from './patterns/FilterBar';
export { ListRow, type ListRowProps } from './patterns/ListRow';
export { FacetList, type FacetListProps, type FacetRow } from './patterns/FacetList';
export { DataTable, type DataTableProps, type DataTableColumn, type DataTableGroup } from './patterns/DataTable';
export { Markdown, type MarkdownProps } from './patterns/Markdown';
export { DayGroup, dayLabel, type DayGroupProps } from './patterns/DayGroup';
export { ShowMore, type ShowMoreProps } from './patterns/ShowMore';
export { FactsPanel, FactRow, type FactsPanelProps, type FactRowProps } from './patterns/FactsPanel';
export { Stat, type StatProps } from './patterns/Stat';
export { EmptyState, type EmptyStateProps } from './patterns/EmptyState';
export { ErrorState, errorWords, type ErrorStateProps, type ErrorWords } from './patterns/ErrorState';
export { LoadingState, Skeleton, type LoadingStateProps } from './patterns/LoadingState';
export { CommandBlock, type CommandBlockProps } from './patterns/CommandBlock';
export { SlideOver, type SlideOverProps } from './patterns/SlideOver';
export { Breadcrumbs, type BreadcrumbsProps, type Crumb } from './patterns/Breadcrumbs';
export { focusRing, tapTarget } from './lib/classes';

export { AppShell, BottomBar, useShellMenu, COMPACT_QUERY, PHONE_QUERY, type AppShellProps, type BottomBarItem } from './shell/AppShell';
export {
  Sidebar, NavItem, NavGroup, NavSection, SearchTrigger, Brand, type SidebarProps, type NavItemProps, type NavGroupProps, type NavSectionProps,
} from './shell/Sidebar';
export { ScopeSwitcher, recencyOf, type ScopeSwitcherProps, type ScopeProject, type ScopeAll } from './shell/ScopeSwitcher';
export { AccountMenu, type AccountMenuProps } from './shell/AccountMenu';
export { SearchCommand, useSearchShortcut, type SearchCommandProps } from './shell/SearchCommand';

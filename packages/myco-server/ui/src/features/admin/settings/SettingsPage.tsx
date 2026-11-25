import { useLocation } from 'react-router-dom';
import { ErrorState, LoadingState, Link, TabLinks } from '../../../design';
import { useSettings } from '../../../hooks/use-settings';
import { anchorOf, HEALTH_ANCHORS, MEASURES_PATH, MOVED_SETTINGS_SECTIONS, SETTINGS_PATH, SETTINGS_SECTIONS, type SettingsSectionId } from '../../../routes/nav';
import { AdminPage, AdminSection, useAnchorScroll } from '../AdminFrame';
import { ADVANCED_ANCHOR, ADVANCED_ANCHORS, AdvancedSection, GroupCard } from './AdvancedGroups';
import { AgentWork } from './AgentWork';
import { ADVANCED_FOLDS, groupsOf, LEAF_GROUPS, type LeafGroup } from './catalogue';
import { Connections } from './Connections';
import { CREDENTIALS_ANCHOR } from './Credentials';
import { GITHUB_ANCHOR } from './GitHubApp';
import { MycosWork } from './MycosWork';
import { PeopleAndMachines, SIGN_IN_ANCHOR } from './PeopleAndMachines';
import { QuickJobs } from './QuickJobs';
import { PROJECTS_ANCHOR, Repositories } from './Repositories';
import { TELEMETRY_ANCHOR } from './TelemetryKeys';
import type { LeafRow, SettingsAnswer } from './wire';

const sectionPath = (id: SettingsSectionId): string => SETTINGS_SECTIONS.find((s) => s.id === id)?.to ?? SETTINGS_PATH;

/** The section each anchor a link may name lives on: every settings group's, each Advanced group's, and the parts that are not groups. */
const ANCHOR_SECTION: ReadonlyMap<string, SettingsSectionId> = new Map<string, SettingsSectionId>([
  ...LEAF_GROUPS.map((group) => [group.id, group.section] as const),
  ...ADVANCED_FOLDS.map((fold) => [fold.id, 'advanced'] as const),
  ...ADVANCED_ANCHORS.map(([anchor]) => [anchor, 'advanced'] as const),
  [ADVANCED_ANCHOR, 'advanced'],
  [CREDENTIALS_ANCHOR, 'connections'],
  [TELEMETRY_ANCHOR, 'connections'],
  [GITHUB_ANCHOR, 'repositories'],
  [PROJECTS_ANCHOR, 'repositories'],
  [SIGN_IN_ANCHOR, 'people'],
]);

/**
 * Where an older `/settings?tab=` link leads: the section that holds that
 * group now, at the group. Keys and the per-project list had tabs of their own.
 */
export function oldTabTarget(tab: string): string {
  if (tab === 'agent') return sectionPath('models');
  if (tab === 'learning') return SETTINGS_PATH;
  if (tab === 'secrets') return `${sectionPath('connections')}#${CREDENTIALS_ANCHOR}`;
  if (tab === 'capabilities') return `${sectionPath('repositories')}#${PROJECTS_ANCHOR}`;
  const section = ANCHOR_SECTION.get(tab);
  return section === undefined ? SETTINGS_PATH : `${sectionPath(section)}#${tab}`;
}

/** The anchor Health's measures had, which now lead to their own page. */
const MEASURES_ANCHOR = 'measures';
const HEALTH_OWN: ReadonlySet<string> = new Set(Object.values(HEALTH_ANCHORS));

/**
 * Where an address of Health leads now, or null when it is current: an anchor of a part that moved to Settings, under
 * the section that holds it; the measures to their own page, their window kept.
 */
export function healthAddress(search: string, hash: string): string | null {
  const anchor = anchorOf(hash);
  if (anchor === MEASURES_ANCHOR) return `${MEASURES_PATH}${search}`;
  if (anchor === '' || HEALTH_OWN.has(anchor)) return null;
  const section = ANCHOR_SECTION.get(anchor);
  return section === undefined ? null : `${sectionPath(section)}${search}#${anchor}`;
}

/** Anchors an older page named that are now another anchor. */
const ANCHOR_ALIASES: Readonly<Record<string, string>> = { 'models-advanced': ADVANCED_ANCHOR };

/** The section an address of Settings shows, current or older: null for an address Settings never had. */
function sectionAt(pathname: string): SettingsSectionId | null {
  const path = pathname.replace(/(.)\/+$/, '$1');
  return SETTINGS_SECTIONS.find((s) => s.to === path)?.id ?? MOVED_SETTINGS_SECTIONS.find((s) => s.from === path)?.to ?? null;
}

/**
 * Where any Settings address leads now, or null when it is already current: a `?tab=` link to the place that holds
 * that group; an older section's address to the section that took its settings; an anchor, under its current name, on
 * the section that holds it now.
 */
export function settingsAddress(pathname: string, search: string, hash: string): string | null {
  const tab = new URLSearchParams(search).get('tab');
  if (tab !== null) return oldTabTarget(tab);
  const section = sectionAt(pathname);
  if (section === null) return null;
  const moved = MOVED_SETTINGS_SECTIONS.find((s) => s.from === pathname.replace(/(.)\/+$/, '$1'));
  const named = anchorOf(hash) || (moved !== undefined && 'anchor' in moved ? moved.anchor : '');
  const anchor = ANCHOR_ALIASES[named] ?? named;
  const target = `${sectionPath(ANCHOR_SECTION.get(anchor) ?? section)}${anchor === '' ? '' : `#${anchor}`}`;
  return target === `${pathname}${hash}` ? null : target;
}

/** Where the address of this page leads now, or null when it is current. */
export function useSettingsRedirect(): string | null {
  const { pathname, search, hash } = useLocation();
  return settingsAddress(pathname, search, hash);
}

/**
 * Settings: what this server holds for every member, in six sections, each at
 * its own address. Every change saves as it is made and says who made it.
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const settings = useSettings();
  // Connections scrolls to its anchor itself, once its lists have loaded.
  useAnchorScroll(section === 'people' || section === 'repositories' || (section !== 'connections' && !settings.isPending));

  const tabs = SETTINGS_SECTIONS.map((s) => ({ to: s.to, label: s.label, active: s.id === section }));
  return (
    <AdminPage
      name={`settings-${section}`}
      scope="server"
      title="Settings"
      lede="The few things you decide. Everything else works as it is."
    >
      <TabLinks label="Settings sections" items={tabs} className="-mt-s4" />
      {section === 'people' ? <PeopleAndMachines />
        : section === 'repositories' ? <Repositories />
        : section === 'connections' ? <Connections />
        : section === 'advanced' && settings.isError ? <AdvancedSection answer={null} rows={new Map()} unread={<ErrorState error={settings.error} onRetry={() => void settings.refetch()} />} />
        : settings.isPending ? <LoadingState label="Loading settings" />
        : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        : section === 'models' ? <ModelsSection answer={settings.data} />
        : section === 'advanced' ? <AdvancedSection answer={settings.data} rows={rowsOf(settings.data)} />
        : <MycosWork rows={rowsOf(settings.data)} />}
    </AdminPage>
  );
}

const rowsOf = (answer: SettingsAnswer): ReadonlyMap<string, LeafRow> => new Map(answer.leaves.map((l) => [l.leaf, l]));

/** Models: who answers quick jobs, which agent does the rest and who pays for it, and the model search reads with. */
function ModelsSection({ answer }: { answer: SettingsAnswer }) {
  const rows = rowsOf(answer);
  const groups = groupsOf('models');
  const own = (id: string): LeafGroup => groups.find((group) => group.id === id)!;
  const search = own('embedding');
  return (
    <>
      <QuickJobs group={own('single-turn')} rows={rows} fact={answer.quickJobs} />
      <AgentWork group={own('workers')} rows={rows} />
      <p className="-mt-s4 max-w-measure t-small text-muted" data-model-sizes-pointer="">
        Myco picks a small, medium or large model for each job by itself. Change that under <Link to={`${sectionPath('advanced')}#model-sizes`}>Advanced › Model sizes</Link>.
      </p>
      <AdminSection id={search.id} title={search.label} description={search.note}>
        <GroupCard group={search} rows={rows} />
      </AdminSection>
    </>
  );
}

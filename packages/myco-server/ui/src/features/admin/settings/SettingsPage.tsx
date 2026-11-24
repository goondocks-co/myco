import { Fragment, type ReactElement } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState, TabLinks } from '../../../design';
import { useSettings } from '../../../hooks/use-settings';
import { SETTINGS_PATH, SETTINGS_SECTIONS, type SettingsSectionId } from '../../../routes/nav';
import { AdminPage, AdminSection, useAnchorScroll } from '../AdminFrame';
import { AccessPointers, PROJECTS_ANCHOR } from './AccessPointers';
import { AdvancedGroups, GroupCard, TASK_SIZES_ANCHOR } from './AdvancedGroups';
import { AgentWork } from './AgentWork';
import { groupsOf, LEAF_GROUPS, type LeafGroup } from './catalogue';
import { Connections } from './Connections';
import { CREDENTIALS_ANCHOR } from './Credentials';
import { GITHUB_ANCHOR } from './GitHubApp';
import { QuickJobs } from './QuickJobs';
import { isRetired } from './retired';
import { TELEMETRY_ANCHOR } from './TelemetryKeys';
import { TitlingSwitch } from './TitlingSwitch';
import type { LeafRow, SettingsAnswer } from './wire';

const sectionPath = (id: SettingsSectionId): string => SETTINGS_SECTIONS.find((s) => s.id === id)?.to ?? SETTINGS_PATH;

/** The section each anchor a link may name lives on: every settings group's, and the parts that are not groups. */
const ANCHOR_SECTION: ReadonlyMap<string, SettingsSectionId> = new Map<string, SettingsSectionId>([
  ...LEAF_GROUPS.map((group) => [group.id, group.section] as const),
  [TASK_SIZES_ANCHOR, 'models'],
  [CREDENTIALS_ANCHOR, 'connections'],
  [TELEMETRY_ANCHOR, 'connections'],
  [GITHUB_ANCHOR, 'connections'],
  [PROJECTS_ANCHOR, 'access'],
]);

/**
 * Where an older `/settings?tab=` link leads: the section that holds that
 * group now, at the group. Keys and the per-project list had tabs of their own.
 */
export function oldTabTarget(tab: string): string {
  if (tab === 'agent') return sectionPath('models');
  if (tab === 'learning') return SETTINGS_PATH;
  if (tab === 'secrets') return `${sectionPath('connections')}#${CREDENTIALS_ANCHOR}`;
  if (tab === 'capabilities') return `${sectionPath('access')}#${PROJECTS_ANCHOR}`;
  const section = ANCHOR_SECTION.get(tab);
  return section === undefined ? SETTINGS_PATH : `${sectionPath(section)}#${tab}`;
}

/** Where a link to an anchor that has moved to another section leads now, or null when the anchor is on this section. */
export function movedAnchorTarget(section: SettingsSectionId, hash: string): string | null {
  const anchor = decodeURIComponent(hash.replace(/^#/, ''));
  const home = ANCHOR_SECTION.get(anchor);
  return home === undefined || home === section ? null : `${sectionPath(home)}#${anchor}`;
}

/** Where an older address of this section leads now: a `?tab=` link, or an anchor that moved to another section; null when it is current. */
export function useSettingsRedirect(section: SettingsSectionId): string | null {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const tab = params.get('tab');
  return tab !== null ? oldTabTarget(tab) : movedAnchorTarget(section, hash);
}

/** Parts of a section that are not settings groups, placed after the group they follow. */
const AFTER_GROUP: Readonly<Record<string, () => ReactElement>> = {
  scheduling: () => <TitlingSwitch />,
};

/**
 * Settings: what this server holds for every member, in sections, each at
 * its own address. Every change saves as it is made and says who made it.
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const settings = useSettings();
  // Connections scrolls to its anchor itself, once its lists have loaded.
  useAnchorScroll(section === 'access' || (section !== 'connections' && settings.isSuccess));

  const tabs = SETTINGS_SECTIONS.map((s) => ({ to: s.to, label: s.label, active: s.id === section }));
  return (
    <AdminPage
      name={`settings-${section}`}
      scope="server"
      title="Settings"
      lede="What this server holds for every member. Each change saves as you make it and says who made it."
    >
      <TabLinks label="Settings sections" items={tabs} className="-mt-s4" />
      {section === 'access' ? <AccessPointers />
        : section === 'connections' ? <Connections />
        : settings.isPending ? <LoadingState label="Loading settings" />
        : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        : section === 'models' ? <ModelsSection answer={settings.data} />
        : <SectionGroups groups={groupsOf(section)} rows={rowsOf(settings.data)} />}
    </AdminPage>
  );
}

const rowsOf = (answer: SettingsAnswer): ReadonlyMap<string, LeafRow> => new Map(answer.leaves.map((l) => [l.leaf, l]));

/** Models: who answers quick jobs, which agent does the rest and who pays for it, then Advanced, folded. */
function ModelsSection({ answer }: { answer: SettingsAnswer }) {
  const rows = rowsOf(answer);
  const groups = groupsOf('models');
  const own = (id: string): LeafGroup => groups.find((group) => group.id === id)!;
  return (
    <>
      <QuickJobs group={own('single-turn')} rows={rows} fact={answer.quickJobs} />
      <AgentWork group={own('workers')} rows={rows} />
      <AdvancedGroups groups={groups.filter((group) => group.advanced === true)} rows={rows} tiers={answer.taskTiers} />
    </>
  );
}

/** The live settings groups, with every control reading its consumer's effective answer. */
function SectionGroups({ groups, rows }: { groups: readonly LeafGroup[]; rows: ReadonlyMap<string, LeafRow> }) {
  return (
    <>
      {groups.map((group) => (
        <Fragment key={group.id}>
          {group.leaves.some((field) => !isRetired(field, rows.get(field.leaf))) && (
            <AdminSection id={group.id} title={group.label} description={group.note}>
              <GroupCard group={group} rows={rows} />
            </AdminSection>
          )}
          {AFTER_GROUP[group.id]?.()}
        </Fragment>
      ))}
    </>
  );
}

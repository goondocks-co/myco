import { useLocation, useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState, Link, TabLinks } from '../../../design';
import { useSettings } from '../../../hooks/use-settings';
import { SETTINGS_PATH, SETTINGS_SECTIONS, type SettingsSectionId } from '../../../routes/nav';
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
  ['models-advanced', 'advanced'],
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

/** Where a link to an anchor that has moved to another section leads now, or null when the anchor is on this section. */
export function movedAnchorTarget(section: SettingsSectionId, hash: string): string | null {
  const anchor = decodeURIComponent(hash.replace(/^#/, ''));
  const home = ANCHOR_SECTION.get(anchor);
  return home === undefined || home === section ? null : `${sectionPath(home)}#${anchor}`;
}

/** Where an address of a section that no longer has a tab leads: its anchor's section when it names one, else the section that took its settings. */
export function movedSectionTarget(to: SettingsSectionId, hash: string): string {
  return movedAnchorTarget(to, hash) ?? `${sectionPath(to)}${hash}`;
}

/** Where an older address of this section leads now: a `?tab=` link, or an anchor that moved to another section; null when it is current. */
export function useSettingsRedirect(section: SettingsSectionId): string | null {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const tab = params.get('tab');
  return tab !== null ? oldTabTarget(tab) : movedAnchorTarget(section, hash);
}

/**
 * Settings: what this server holds for every member, in six sections, each at
 * its own address. Every change saves as it is made and says who made it.
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const settings = useSettings();
  // Connections scrolls to its anchor itself, once its lists have loaded.
  useAnchorScroll(section === 'people' || section === 'repositories' || (section !== 'connections' && settings.isSuccess));

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

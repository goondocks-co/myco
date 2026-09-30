import { Fragment, type ReactElement } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Disclosure, ErrorState, LoadingState, TabLinks } from '../../../design';
import { useSettings } from '../../../hooks/use-settings';
import { SETTINGS_PATH, SETTINGS_SECTIONS, type SettingsSectionId } from '../../../routes/nav';
import { AdminPage, AdminSection, RowCard, useAnchorScroll } from '../AdminFrame';
import { AccessPointers, PROJECTS_ANCHOR } from './AccessPointers';
import { groupsOf, LEAF_GROUPS, type LeafGroup } from './catalogue';
import { Credentials, CREDENTIALS_ANCHOR } from './Credentials';
import { LeafControl } from './LeafControl';
import { TitlingSwitch } from './TitlingSwitch';
import type { LeafRow } from './wire';

const sectionPath = (id: SettingsSectionId): string => SETTINGS_SECTIONS.find((s) => s.id === id)?.to ?? SETTINGS_PATH;

/**
 * Where an older `/settings?tab=` link leads: the section that holds that
 * group now, at the group. Keys and the per-project list had tabs of their own.
 */
export function oldTabTarget(tab: string): string {
  if (tab === 'secrets') return `${sectionPath('models')}#${CREDENTIALS_ANCHOR}`;
  if (tab === 'capabilities') return `${sectionPath('access')}#${PROJECTS_ANCHOR}`;
  const group = LEAF_GROUPS.find((g) => g.id === tab);
  return group === undefined ? SETTINGS_PATH : `${sectionPath(group.section)}#${group.id}`;
}

/** Parts of a section that are not settings groups, placed after the group they follow. */
const AFTER_GROUP: Readonly<Record<string, () => ReactElement>> = {
  scheduling: () => <TitlingSwitch />,
  agent: () => <Credentials />,
};

/**
 * Settings: what this server holds for every member, in five sections, each at
 * its own address. Every change saves as it is made and says who made it.
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const [params] = useSearchParams();
  const tab = params.get('tab');
  const settings = useSettings();
  useAnchorScroll(section === 'access' || settings.isSuccess);
  if (tab !== null) return <Navigate to={oldTabTarget(tab)} replace />;

  const tabs = SETTINGS_SECTIONS.map((s) => ({ to: s.to, label: s.label, active: s.id === section }));
  return (
    <AdminPage
      name={`settings-${section}`}
      title="Settings"
      lede="What this server holds for every member. Each change saves as you make it and says who made it."
    >
      <TabLinks label="Settings sections" items={tabs} className="-mt-s4" />
      {section === 'access' ? <AccessPointers /> : (
        settings.isPending ? <LoadingState label="Loading settings" />
          : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          : <SectionGroups groups={groupsOf(section)} rows={new Map(settings.data.leaves.map((l) => [l.leaf, l]))} />
      )}
    </AdminPage>
  );
}

/**
 * A section's groups, each showing the settings that still do something. A
 * group whose settings are all retired is left out; a retired setting with a
 * value stored is listed, read-only, under "Older settings" at the section's
 * foot, so what an older Deployment stored stays visible.
 */
function SectionGroups({ groups, rows }: { groups: readonly LeafGroup[]; rows: ReadonlyMap<string, LeafRow> }) {
  const older = groups.flatMap((group) => group.leaves.filter((field) => field.retired === true && rows.get(field.leaf)?.configured === true));
  return (
    <>
      {groups.map((group) => {
        const live = group.leaves.filter((field) => field.retired !== true);
        return (
          <Fragment key={group.id}>
            {live.length > 0 && (
              <AdminSection id={group.id} title={group.label} description={group.note}>
                <RowCard label={group.label}>
                  {live.map((field) => <LeafControl key={field.leaf} field={field} row={rows.get(field.leaf)} />)}
                </RowCard>
              </AdminSection>
            )}
            {AFTER_GROUP[group.id]?.()}
          </Fragment>
        );
      })}
      {older.length > 0 && (
        <section aria-label="Older settings" data-older-settings="">
          <Disclosure summary={`Older settings (${older.length})`}>
            <p className="max-w-measure t-small text-muted">Values an earlier version of Myco stored. Nothing on this server reads them any more.</p>
            <RowCard label="Older settings">
              {older.map((field) => <LeafControl key={field.leaf} field={field} row={rows.get(field.leaf)} />)}
            </RowCard>
          </Disclosure>
        </section>
      )}
    </>
  );
}

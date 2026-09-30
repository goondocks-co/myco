import { AdminPage } from '../AdminFrame';
import type { SettingsSectionId } from '../../../routes/nav';

/** `/settings` and its sections: what this server holds for every member. */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  return <AdminPage name={`settings-${section}`} title="Settings">{null}</AdminPage>;
}

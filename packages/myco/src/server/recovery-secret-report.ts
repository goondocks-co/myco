import { SECRET_SLOTS } from '@goondocks/myco-shared/secret-slots';

/** Names and re-entry locations for credentials omitted from a recovered Deployment. */
export function recoveryCredentialLines(names: readonly string[]): string[] {
  return ['Stored credentials must be entered again:', ...(names.length === 0 ? ['  None were stored.'] : names.map(name => {
    const location = name.startsWith('repository:') ? 'Project Settings → Repository access'
      : name.startsWith('release-provenance:') ? 'Project Settings → Release tracking'
      : 'Settings → Models and keys';
    const label = SECRET_SLOTS.find(slot => slot.name === name)?.label;
    return `  ${label === undefined ? name : `${label} (${name})`}: ${location}`;
  }))];
}

import { useState } from 'react';
import { Disclosure, ErrorState, LoadingState, Switch } from '../../../design';
import { settingsRefusalText, useCapabilities, useSettingsActions } from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS } from '../../../routes/nav';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';

/** What each capability does in a project, in the reader's words. */
const CAPABILITY_WORDS: Readonly<Record<string, { label: string; note: string }>> = {
  cortex: { label: 'Context for sessions', note: 'Sessions here are handed the instructions at start, and spores and plans on their prompts.' },
  canopy: { label: 'Code map', note: 'Myco keeps a map of where things live in this project’s code, from its repository.' },
  skills: { label: 'Skills', note: 'Nothing on this server reads this switch any more: skills ship with Myco.' },
  vault_evolution: { label: 'Learning', note: 'Myco learns spores from this project’s sessions and keeps them current.' },
};

/** Capabilities nothing on the server reads any more: shown only while on, read-only, under "Older". */
export const RETIRED_CAPABILITIES: ReadonlySet<string> = new Set(['skills']);

/** One capability's switch, saving as it is flipped and saying why when the server refuses. */
function CapabilityRow({ projectId, capability, enabled, readOnly = false }: { projectId: string; capability: string; enabled: boolean; readOnly?: boolean }) {
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  const words = CAPABILITY_WORDS[capability] ?? { label: capability, note: undefined };
  const id = `capability-${capability}`;
  return (
    <SettingRow
      inline
      setting={`capability.${capability}`}
      label={words.label}
      htmlFor={id}
      note={words.note}
      status={error ?? (enabled ? 'On' : 'Off')}
      refused={error !== null}
      control={(
        <Switch
          id={id}
          aria-label={words.label}
          checked={enabled}
          disabled={readOnly || actions.setCapability.isPending}
          onCheckedChange={(checked) => {
            setError(null);
            actions.setCapability.mutate({ projectId, capability, enabled: checked }, { onError: (err) => setError(settingsRefusalText(err)) });
          }}
        />
      )}
    />
  );
}

/** What Myco does in a project: a switch per capability. */
export function Capabilities({ projectId }: { projectId: string }) {
  const caps = useCapabilities(projectId);
  return (
    <AdminSection id={PROJECT_SETTINGS_ANCHORS.capabilities} title="What Myco does here" description="Each switch saves as you flip it.">
      {caps.isPending ? <LoadingState label="Loading what Myco does here" count={4} />
        : caps.isError ? <ErrorState error={caps.error} onRetry={() => void caps.refetch()} />
        : (
          <>
            <RowCard label="What Myco does here">
              {Object.entries(caps.data.capabilities).filter(([capability]) => !RETIRED_CAPABILITIES.has(capability)).map(([capability, enabled]) => (
                <CapabilityRow key={capability} projectId={projectId} capability={capability} enabled={enabled} />
              ))}
            </RowCard>
            {Object.entries(caps.data.capabilities).some(([capability, enabled]) => RETIRED_CAPABILITIES.has(capability) && enabled) && (
              <Disclosure summary="Older">
                <RowCard label="Older">
                  {Object.entries(caps.data.capabilities).filter(([capability, enabled]) => RETIRED_CAPABILITIES.has(capability) && enabled).map(([capability, enabled]) => (
                    <CapabilityRow key={capability} projectId={projectId} capability={capability} enabled={enabled} readOnly />
                  ))}
                </RowCard>
              </Disclosure>
            )}
          </>
        )}
    </AdminSection>
  );
}

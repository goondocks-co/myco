import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Field, numChange } from './config-helpers';

interface ContextSectionProps {
  context: MycoConfig['context'];
  isDirty: boolean;
  updateContext: (key: string, value: number) => void;
  updateContextLayer: (key: string, value: number) => void;
}

export function ContextSection({
  context,
  isDirty,
  updateContext,
  updateContextLayer,
}: ContextSectionProps) {
  return (
    <ConfigSection
      title="Context"
      description="Context injection token budget and layer allocations"
      isDirty={isDirty}
    >
      <div className="space-y-4">
        <Field
          label="Max Tokens"
          description="Total token budget for per-prompt context injection"
        >
          <Input
            type="number"
            value={context.max_tokens}
            onChange={numChange(updateContext, 'max_tokens')}
          />
        </Field>
        <div>
          <h4 className="mb-1 text-sm font-medium text-muted-foreground">Layer Allocations</h4>
          <p className="mb-3 text-xs text-muted-foreground">
            How the budget is split across vault content types
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plans">
              <Input
                type="number"
                value={context.layers.plans}
                onChange={numChange(updateContextLayer, 'plans')}
              />
            </Field>
            <Field label="Sessions">
              <Input
                type="number"
                value={context.layers.sessions}
                onChange={numChange(updateContextLayer, 'sessions')}
              />
            </Field>
            <Field label="Spores">
              <Input
                type="number"
                value={context.layers.spores}
                onChange={numChange(updateContextLayer, 'spores')}
              />
            </Field>
            <Field label="Team">
              <Input
                type="number"
                value={context.layers.team}
                onChange={numChange(updateContextLayer, 'team')}
              />
            </Field>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}

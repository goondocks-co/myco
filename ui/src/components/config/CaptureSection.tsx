import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Field, numChange } from './config-helpers';

interface CaptureSectionProps {
  capture: MycoConfig['capture'];
  isDirty: boolean;
  updateCapture: (key: string, value: number) => void;
}

export function CaptureSection({ capture, isDirty, updateCapture }: CaptureSectionProps) {
  return (
    <ConfigSection
      title="Capture"
      description="Event buffering and token budgets for LLM processing"
      isDirty={isDirty}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Buffer Max Events" description="Maximum events to buffer per session before flushing">
          <Input
            type="number"
            value={capture.buffer_max_events}
            onChange={numChange(updateCapture, 'buffer_max_events')}
          />
        </Field>
        <Field label="Extraction Max Tokens" description="Output token limit for observation extraction from sessions">
          <Input
            type="number"
            value={capture.extraction_max_tokens}
            onChange={numChange(updateCapture, 'extraction_max_tokens')}
          />
        </Field>
        <Field label="Summary Max Tokens" description="Output token limit for session summary generation">
          <Input
            type="number"
            value={capture.summary_max_tokens}
            onChange={numChange(updateCapture, 'summary_max_tokens')}
          />
        </Field>
        <Field label="Title Max Tokens" description="Output token limit for session title generation">
          <Input
            type="number"
            value={capture.title_max_tokens}
            onChange={numChange(updateCapture, 'title_max_tokens')}
          />
        </Field>
        <Field label="Classification Max Tokens" description="Output token limit for artifact classification">
          <Input
            type="number"
            value={capture.classification_max_tokens}
            onChange={numChange(updateCapture, 'classification_max_tokens')}
          />
        </Field>
      </div>
    </ConfigSection>
  );
}

import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Field, numChange } from './config-helpers';

interface PipelineSectionProps {
  pipeline: MycoConfig['pipeline'];
  isDirty: boolean;
  updatePipeline: (key: string, value: number) => void;
  updatePipelineRetry: (key: string, value: number) => void;
  updatePipelineCircuitBreaker: (key: string, value: number) => void;
}

export function PipelineSection({
  pipeline,
  isDirty,
  updatePipeline,
  updatePipelineRetry,
  updatePipelineCircuitBreaker,
}: PipelineSectionProps) {
  return (
    <ConfigSection
      title="Pipeline"
      description="Work item processing, retry behavior, and circuit breaker settings"
      isDirty={isDirty}
    >
      {/* Processing */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-muted-foreground">Processing</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Batch Size" description="Work items processed per stage per pipeline tick">
            <Input
              type="number"
              value={pipeline.batch_size}
              onChange={numChange(updatePipeline, 'batch_size')}
            />
          </Field>
          <Field label="Tick Interval (sec)" description="Seconds between pipeline processing ticks">
            <Input
              type="number"
              value={pipeline.tick_interval_seconds}
              onChange={numChange(updatePipeline, 'tick_interval_seconds')}
            />
          </Field>
          <Field label="Retention Days" description="Days to retain completed/failed work items before compaction">
            <Input
              type="number"
              value={pipeline.retention_days}
              onChange={numChange(updatePipeline, 'retention_days')}
            />
          </Field>
        </div>
      </div>

      {/* Retry */}
      <div className="space-y-4 pt-4">
        <h4 className="text-sm font-medium text-muted-foreground">Retry</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max Transient Retries" description="Maximum retry attempts for recoverable failures">
            <Input
              type="number"
              value={pipeline.retry.transient_max}
              onChange={numChange(updatePipelineRetry, 'transient_max')}
            />
          </Field>
          <Field label="Backoff Base (sec)" description="Base delay between retry attempts (exponential backoff)">
            <Input
              type="number"
              value={pipeline.retry.backoff_base_seconds}
              onChange={numChange(updatePipelineRetry, 'backoff_base_seconds')}
            />
          </Field>
        </div>
      </div>

      {/* Circuit Breaker */}
      <div className="space-y-4 pt-4">
        <h4 className="text-sm font-medium text-muted-foreground">Circuit Breaker</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Failure Threshold" description="Consecutive failures before opening a circuit breaker">
            <Input
              type="number"
              value={pipeline.circuit_breaker.failure_threshold}
              onChange={numChange(updatePipelineCircuitBreaker, 'failure_threshold')}
            />
          </Field>
          <Field label="Cooldown (sec)" description="Initial cooldown duration when a circuit breaker opens">
            <Input
              type="number"
              value={pipeline.circuit_breaker.cooldown_seconds}
              onChange={numChange(updatePipelineCircuitBreaker, 'cooldown_seconds')}
            />
          </Field>
          <Field label="Max Cooldown (sec)" description="Maximum cooldown duration for exponential backoff">
            <Input
              type="number"
              value={pipeline.circuit_breaker.max_cooldown_seconds}
              onChange={numChange(updatePipelineCircuitBreaker, 'max_cooldown_seconds')}
            />
          </Field>
        </div>
      </div>
    </ConfigSection>
  );
}

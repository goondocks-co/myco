import { Disclosure } from '../../design';

/** The saved value, folded away until the operator asks to inspect it. */
export function StoredValue({ value, summary = 'Stored value' }: { value: unknown; summary?: string }) {
  return <Disclosure summary={summary}><pre className="t-mono t-small whitespace-pre-wrap break-all text-muted">{JSON.stringify(value, null, 2)}</pre></Disclosure>;
}

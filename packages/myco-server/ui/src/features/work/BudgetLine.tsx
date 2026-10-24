import { useStatus } from '../../hooks/use-status';
import { budgetStatusLine } from '@goondocks/myco-shared/budget-status';

export function BudgetLine() {
  const status=useStatus();
  if (status.isError) return <p aria-live="polite">Daily work budget unavailable.</p>;
  return <p aria-live="polite" className="t-body text-muted">{status.data===undefined?'Reading daily work budget…':status.data.budget===undefined?'Daily work budget unavailable.':budgetStatusLine(status.data.budget)}</p>;
}

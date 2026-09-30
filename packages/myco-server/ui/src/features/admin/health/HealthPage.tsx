import { AdminPage } from '../AdminFrame';

/** `/status/health`: whether this server is well, what it is doing, and what needs an admin. */
export function HealthPage() {
  return <AdminPage name="health" title="Health">{null}</AdminPage>;
}

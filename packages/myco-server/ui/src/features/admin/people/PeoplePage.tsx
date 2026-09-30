import { AdminPage } from '../AdminFrame';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';

/** `/people`: who is a member, the invitations still open, and the machines that write here. */
export function PeoplePage() {
  return <AdminPage name="people" title={INVITE_CONTROLS.page}>{null}</AdminPage>;
}

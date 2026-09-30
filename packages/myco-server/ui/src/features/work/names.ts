import { useMe } from '../../hooks/use-me';
import { useMemberNames } from '../admin/members';

/**
 * Who started a run, by member id: "you" for the viewer, else the member's
 * name, else null for a member the list names only by id. Never the id.
 */
export function useStarterNames(): (id: string) => string | null {
  const me = useMe().data?.member?.id ?? null;
  const names = useMemberNames();
  return (id) => (id === me ? 'you' : names(id));
}

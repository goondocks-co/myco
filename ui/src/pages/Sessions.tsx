import { useParams } from 'react-router-dom';
import { SessionList } from '../components/sessions/SessionList';
import { SessionDetail } from '../components/sessions/SessionDetail';

export default function Sessions() {
  const { id } = useParams<{ id: string }>();

  if (id) return <SessionDetail id={id} />;
  return <SessionList />;
}

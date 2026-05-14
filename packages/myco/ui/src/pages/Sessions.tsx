import { useParams, useNavigate } from 'react-router-dom';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { EmptyDetailHint } from '../components/ui/empty-detail-hint';
import { SessionList } from '../components/sessions/SessionList';
import { SessionDetail } from '../components/sessions/SessionDetail';

export default function Sessions() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <MasterDetailSplit
      hasSelection={!!id}
      onCloseMobileDetail={() => navigate('..')}
      masterAriaLabel="Sessions"
      detailAriaLabel="Session details"
      master={<SessionList selectedId={id} />}
      detail={
        id ? (
          <SessionDetail id={id} />
        ) : (
          <EmptyDetailHint message="Select a session to see its details." />
        )
      }
    />
  );
}

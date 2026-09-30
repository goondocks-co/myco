import { ActionLink } from '../design';
import { PROJECTS_PATH } from '../routes/nav';

/** An address that names nothing: says so, and leads back to the projects. */
export function NotFound() {
  return (
    <div className="flex max-w-measure flex-col gap-s3" data-not-found="">
      <h1 className="t-display text-ink">Not found</h1>
      <p className="t-body text-muted">There is nothing at this address.</p>
      <ActionLink to={PROJECTS_PATH}>Back to Projects</ActionLink>
    </div>
  );
}

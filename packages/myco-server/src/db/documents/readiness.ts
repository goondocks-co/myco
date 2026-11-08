/** Restore leaves source records intact while publication identity or metadata is being initialized. */
export class PublicationRestoreBuilding extends Error {
  readonly code: 'publication_restore_building'|'publication_restore_metadata_unavailable';
  readonly retryable = true;
  constructor(readonly projection: 'pins' | 'ownership',failure:string|null=null) {
    const code=failure===null?'publication_restore_building':'publication_restore_metadata_unavailable';
    super(failure===null?`${code}: this restore cannot apply document records while ${projection} initializes; keep the artifact and retry the same restore after publication catch-up finishes`
      :`${code}: this restore cannot apply document records because metadata is unavailable (${failure}); retain the artifact, repair the document object and restart publication catch-up, then retry the same restore`);
    this.code=code;
  }
}

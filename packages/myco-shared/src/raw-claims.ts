/** Raw resources whose uploader provenance is absent and may be claimed by the recorded Deployment owner. */
export interface RawClaimKind {
  kind: 'blob' | 'event' | 'transcript';
  count: number;
  oldestAt: number | null;
  newestAt: number | null;
}

export interface RawClaimPreview {
  revision: string;
  complete: boolean;
  projects: Array<{ projectId: string; name: string; kinds: RawClaimKind[] }>;
}

export interface RawClaimOutcome {
  claimId: string | null;
  preview: RawClaimPreview;
}

/** The explicitly recorded owner, or an unclaimed Deployment's reviewed revision. */
export interface DeploymentOwnershipPreview {
  ownerMemberId: string | null;
  revision: string;
}

/**
 * Which Gravity pending-integration row an upsert reuses, and which rows are
 * still reportable. Pure; used by the Convex mutations
 * (freebuff/web/convex/gravity_integrations.ts) and their Postgres port
 * (packages/internal/src/kept-integrations/gravity.ts, COD-742 batch 6).
 */
export type PendingIntegrationState = {
  searchId: string;
  reportedAt?: number;
  credentialsConfiguredAt?: number;
};

export function integrationSelectionKey(searchId: string, slug: string) {
  return JSON.stringify([searchId, slug]);
}

export function selectPendingIntegrationForUpsert<
  T extends PendingIntegrationState,
>(
  rows: T[],
  searchId: string,
  protectedSearchIds: ReadonlySet<string>,
): T | undefined {
  return (
    rows.find(
      (row) => row.reportedAt === undefined && row.searchId === searchId,
    ) ??
    rows.find(
      (row) =>
        row.reportedAt === undefined && !protectedSearchIds.has(row.searchId),
    )
  );
}

export function reportablePendingIntegrations<
  T extends PendingIntegrationState & { slug: string },
>(
  rows: T[],
  selectedIntegrations?: ReadonlyArray<{ slug: string; searchId: string }>,
): T[] {
  const selectedKeys = selectedIntegrations
    ? new Set(
        selectedIntegrations.map(({ slug, searchId }) =>
          integrationSelectionKey(searchId, slug),
        ),
      )
    : undefined;

  return rows.filter(
    (row) =>
      (!selectedKeys ||
        selectedKeys.has(integrationSelectionKey(row.searchId, row.slug))) &&
      (row.reportedAt === undefined ||
        row.credentialsConfiguredAt === undefined),
  );
}

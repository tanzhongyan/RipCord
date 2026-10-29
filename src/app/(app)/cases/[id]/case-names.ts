import { api } from "~/trpc/server";

/**
 * Provider name and holder alias for one of the owner's cases. `cases.get` has neither,
 * so read them from the owner's list, narrowed to the case's status.
 */
export async function caseNamesFor(
  caseId: string,
  status: string,
): Promise<{ providerName: string | null; holderAlias: string | null }> {
  const listed = await api.cases.list({ status, cursor: null, limit: 100 });
  const row = listed.cases.find((c) => c.id === caseId);
  return { providerName: row?.providerName ?? null, holderAlias: row?.holderAlias ?? null };
}

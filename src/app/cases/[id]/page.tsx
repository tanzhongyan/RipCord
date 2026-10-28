import { api } from "~/trpc/server";
import { CaseDetail } from "./case-detail";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await api.cases.get({ caseId: id });
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <CaseDetail view={view} />
    </main>
  );
}

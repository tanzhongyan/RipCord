import { api } from "~/trpc/server";
import { CaseDetail } from "./case-detail";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [view, timeline, documents, verification] = await Promise.all([
    api.cases.get({ caseId: id }),
    api.cases.timeline({ caseId: id }),
    api.cases.documents({ caseId: id }),
    api.cases.verification({ caseId: id }),
  ]);
  // `cases.get` has no provider name. Read it from the owner's list, narrowed to this status.
  const listed = await api.cases.list({ status: view.case.status, cursor: null, limit: 100 });
  const providerName = listed.cases.find((c) => c.id === id)?.providerName ?? null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <CaseDetail
        view={view}
        timeline={timeline}
        documents={documents}
        verification={verification}
        providerName={providerName}
      />
    </div>
  );
}

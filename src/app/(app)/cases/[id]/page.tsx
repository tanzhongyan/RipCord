import { api } from "~/trpc/server";
import { CaseDetail } from "./case-detail";
import { caseNamesFor } from "./case-names";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [view, timeline, documents, verification] = await Promise.all([
    api.cases.get({ caseId: id }),
    api.cases.timeline({ caseId: id }),
    api.cases.documents({ caseId: id }),
    api.cases.verification({ caseId: id }),
  ]);
  const { providerName, holderAlias } = await caseNamesFor(id, view.case.status);
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <CaseDetail
        view={view}
        timeline={timeline}
        documents={documents}
        verification={verification}
        providerName={providerName}
        holderAlias={holderAlias}
      />
    </div>
  );
}

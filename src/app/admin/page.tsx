import { api } from "~/trpc/server";
import { AdminView } from "./admin-view";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const overview = await api.admin.overview();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <AdminView overview={overview} />
    </main>
  );
}

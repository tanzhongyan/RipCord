import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { api } from "~/trpc/server";
import { AdminView } from "./admin-view";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Non-admins get a 404 so the page does not reveal that /admin exists.
  const overview = await api.admin.overview().catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") notFound();
    throw error;
  });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      <AdminView overview={overview} />
    </div>
  );
}

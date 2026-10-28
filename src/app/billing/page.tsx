import { env } from "~/shared/config/env";
import { api } from "~/trpc/server";
import { BillingView } from "./billing-view";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Number(params.page ?? 1) || 1;
  const [balance, ledger] = await Promise.all([
    api.billing.balance({}),
    api.billing.ledger({ page }),
  ]);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <BillingView balance={balance} ledger={ledger} priceDisplay={env.PRICE_CREDIT_DISPLAY} />
    </main>
  );
}

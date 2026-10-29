import { BrandMark } from "~/shared/components/brand-mark";

/** Pages a holder reaches from an SMS or an assistant: brand header only, no nav, centred card. */
export function HolderShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <BrandMark />
        <span className="text-lg font-semibold tracking-tight">ripcord</span>
      </header>
      <main className="flex flex-1 justify-center px-4 py-6 md:py-12">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

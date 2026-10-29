import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutMenuItem } from "~/features/identity";
import { liveAdminDeps, requireAdmin } from "~/features/providers";
import { auth } from "~/server/auth/auth";
import { AppSidebar } from "~/shared/components/app-sidebar";
import { BrandMark } from "~/shared/components/brand-mark";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/shared/components/ui/sidebar";
import { TooltipProvider } from "~/shared/components/ui/tooltip";
import { site } from "~/shared/config/site";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Every page here reads the session, so none can be prerendered.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  const isAdmin = await requireAdmin(liveAdminDeps(), session.user.id).then(
    () => true,
    () => false,
  );

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar email={session.user.email} isAdmin={isAdmin} signOut={<SignOutMenuItem />} />
        <SidebarInset className="min-h-dvh">
          <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
            <SidebarTrigger className="size-11" aria-label="Open menu" />
            <Link
              href="/dashboard"
              aria-label={`${site.name} dashboard`}
              className="flex min-h-11 items-center gap-2 px-1"
            >
              <BrandMark />
              <span className="font-medium tracking-tight">{site.name.toLowerCase()}</span>
            </Link>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

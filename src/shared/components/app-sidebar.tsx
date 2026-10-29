"use client";

import {
  ChevronsUpDownIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  ReceiptIcon,
  SettingsIcon,
  ShieldIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";

import { BrandMark } from "~/shared/components/brand-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/shared/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/shared/components/ui/sidebar";
import { site } from "~/shared/config/site";

interface AppNavItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboardIcon;
  /** Extra path prefixes that keep this item active (a case belongs to the dashboard). */
  also?: string[];
}

const items: AppNavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon, also: ["/cases"] },
  { label: "Chat", href: "/chat", icon: MessageSquareIcon },
  { label: "Billing", href: "/billing", icon: ReceiptIcon },
  { label: "Settings", href: "/settings", icon: SettingsIcon },
];

const adminItem: AppNavItem = { label: "Admin", href: "/admin", icon: ShieldIcon };

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const isActive = (pathname: string, item: AppNavItem) =>
  [item.href, ...(item.also ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** App navigation. Collapses into a slide-out sheet below `md` (shadcn Sidebar mobile mode). */
export function AppSidebar({
  email,
  isAdmin,
  signOut,
}: {
  email: string;
  isAdmin: boolean;
  /** The sign-out menu item. Passed in because shared code cannot import features. */
  signOut: React.ReactNode;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const nav = isAdmin ? [...items, adminItem] : items;

  return (
    <Sidebar>
      <SidebarHeader>
        <Link
          href="/"
          aria-label={`${site.name} home`}
          className="flex min-h-11 items-center gap-2 px-2"
        >
          <BrandMark />
          <span className="font-medium tracking-tight">{site.name.toLowerCase()}</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu aria-label="App">
              {nav.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={active}
                      render={
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          onClick={() => setOpenMobile(false)}
                        />
                      }
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{email}</span>
                </span>
                <ChevronsUpDownIcon className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                      {themes.map((t) => (
                        <DropdownMenuRadioItem key={t.value} value={t.value}>
                          {t.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                {signOut}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

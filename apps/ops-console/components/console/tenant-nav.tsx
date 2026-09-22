"use client";

/**
 * The tenant links in the top bar. The bar lives in the root layout, which the App Router keeps
 * mounted across client-side navigations, so the active tenant cannot come from the request that
 * rendered the layout: it has to follow the current pathname. Server-rendered with the right
 * tenant on the first load, updated on every navigation after that.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

export interface NavTenant { id: string; display_name: string }

export function activeTenant(pathname: string, tenants: NavTenant[]): string | undefined {
  return tenants.find((t) => pathname === `/${t.id}` || pathname.startsWith(`/${t.id}/`))?.id;
}

export function TenantNav({ tenants }: { tenants: NavTenant[] }) {
  const active = activeTenant(usePathname() ?? "/", tenants);
  return (
    <nav className="flex items-center gap-4 md:gap-6">
      {tenants.map((t) => (
        <Link key={t.id} href={`/${t.id}/deliveries`} aria-current={t.id === active ? "page" : undefined}
          className={cn("whitespace-nowrap text-[14.5px] tracking-[-0.005em]", t.id === active ? "font-medium text-ink" : "font-normal text-ink-muted hover:text-ink")}>
          {t.display_name}
        </Link>
      ))}
    </nav>
  );
}

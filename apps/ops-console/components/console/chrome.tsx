/** Top bar, tenant title row, sub navigation, page container. Navigation is links; the only client state is which tenant link is current. */
import Link from "next/link";
import type { Tenant } from "@/lib/db";
import type { LastRun } from "@/lib/queries";
import { cn } from "cn";
import { Chip, LastRunLine } from "./atoms";
import { TenantNav } from "./tenant-nav";
import { ThemeSwitch } from "./theme-switch";

export const VIEWS = [
  ["deliveries", "Deliveries"],
  ["runs", "Runs"],
  ["revenue", "Daily revenue"],
  ["restatements", "Restatements"],
  ["holds", "Holds"],
] as const;
export type View = (typeof VIEWS)[number][0];

export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1440px] px-5 md:px-20", className)}>{children}</div>;
}

export function RoleStrip({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[10px]", className)}>
      <span className="eyebrow">read-only</span><span className="text-hairline-2">/</span>
      <span className="eyebrow">app_rw role</span><span className="text-hairline-2">/</span>
      <span className="eyebrow">row-level security</span>
    </span>
  );
}

export function TopBar({ tenants, back }: { tenants: Tenant[]; back: string }) {
  return (
    <header className="border-b border-hairline">
      <Container className="flex h-14 items-center justify-between gap-6 md:h-16 md:gap-10">
        <div className="flex items-center gap-5 md:gap-8">
          <Link href="/" className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.015em] text-ink">
            dtc<span className="hidden font-normal text-ink-muted md:inline"> · ops console</span>
          </Link>
          <TenantNav tenants={tenants} />
        </div>
        <div className="flex items-center gap-[10px]">
          <RoleStrip className="hidden md:inline-flex" />
          <span className="hidden text-hairline-2 md:inline">/</span>
          <ThemeSwitch back={back} />
        </div>
      </Container>
    </header>
  );
}

export function TenantHeader({ tenant, view, explainer, lastRun }: { tenant: Tenant; view: View; explainer: React.ReactNode; lastRun: LastRun | null }) {
  return (
    <Container className="pt-8 md:pt-11">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="whitespace-nowrap text-[26px] font-semibold tracking-[-0.025em] text-ink md:text-[30px]">{tenant.display_name}</h1>
        <Chip>{tenant.currency}</Chip>
        <div className="grow" />
        <LastRunLine run={lastRun} />
      </div>
      <p className="mt-3 max-w-[840px] text-[14.5px] leading-[1.55] text-ink-muted">{explainer}</p>
      <nav className="mt-7 flex gap-6 overflow-x-auto border-b border-hairline md:gap-8">
        {VIEWS.map(([v, label]) => (
          <Link key={v} href={`/${tenant.id}/${v}`}
            className={cn("-mb-px whitespace-nowrap border-b-2 pb-[14px] text-[14.5px] tracking-[-0.005em]",
              v === view ? "border-ink font-medium text-ink" : "border-transparent font-normal text-ink-muted hover:text-ink")}>
            {label}
          </Link>
        ))}
      </nav>
    </Container>
  );
}

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-[12px] border border-hairline bg-panel", className)}>{children}</div>;
}

/** The centred panel used by empty states and the unreachable-database message. */
export function Notice({ title, children, commands }: { title: string; children?: React.ReactNode; commands?: string[] }) {
  return (
    <Panel className="flex flex-col items-center px-6 py-16 text-center md:py-[120px]">
      <h3 className="text-[19px] font-medium tracking-[-0.01em] text-ink">{title}</h3>
      {children && <p className="mt-4 max-w-[640px] text-[14.5px] leading-[1.6] text-ink-muted">{children}</p>}
      {commands && (
        <pre className="mt-8 rounded-[8px] border border-hairline bg-code-bg px-7 py-5 text-left font-mono text-[13.5px] leading-[1.9] text-ink-2">
          {commands.join("\n")}
        </pre>
      )}
    </Panel>
  );
}

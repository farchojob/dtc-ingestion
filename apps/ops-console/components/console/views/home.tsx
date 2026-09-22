import Link from "next/link";
import type { Tenant } from "@/lib/db";
import type { MatrixRow, Overview } from "@/lib/queries";
import { count, money, symbol } from "@/lib/format";
import { cn } from "cn";
import { Chip, Eyebrow, LastRunLine, Num } from "../atoms";
import { Panel } from "../chrome";

export function TenantCard({ tenant, o }: { tenant: Tenant; o: Overview }) {
  const sym = symbol(tenant.currency);
  return (
    <Panel className="px-[22px] py-[22px] md:px-9 md:pb-[34px] md:pt-8">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-2">
        <Link href={`/${tenant.id}/deliveries`} className="whitespace-nowrap text-[21px] font-semibold tracking-[-0.02em] text-ink hover:underline">{tenant.display_name}</Link>
        <Chip>{tenant.currency}</Chip>
        <div className="hidden grow md:block" />
        <span className="basis-full md:basis-auto"><LastRunLine run={o.lastRun} size={13} /></span>
      </div>

      <div className="mt-6 flex items-baseline gap-2 md:mt-[30px]">
        <span className="text-[22px] text-ink-muted md:text-[26px]">{sym}</span>
        <Num className="text-[36px] font-medium leading-none tracking-[-0.035em] text-ink md:text-[48px]" mono={false}>{money(o.net)}</Num>
      </div>
      <div className="mt-3 text-[13px] text-ink-muted">net revenue · {o.days} days of revenue</div>

      <div className="mt-6 flex gap-10">
        <div><Eyebrow>gross</Eyebrow><Num className="mt-[7px] block text-[15px] text-ink-2" mono={false}>{sym}{money(o.gross)}</Num></div>
        <div><Eyebrow>refunds</Eyebrow><Num className="mt-[7px] block text-[15px] text-ink-2" mono={false}>{sym}{money(o.refunds)}</Num></div>
      </div>

      <div className="my-[30px] h-px bg-hairline" />

      <div className="grid grid-cols-2 gap-x-[18px] gap-y-6 md:grid-cols-4 md:gap-y-0">
        <Stat href={`/${tenant.id}/deliveries`} label="Deliveries" value={o.expected ? `${o.loaded} / ${o.expected}` : `${o.loaded}`} bad={o.missing > 0}
          note={o.missing ? `${o.missing} batch${o.missing > 1 ? "es" : ""} never arrived` : o.expected ? "all arrived" : "loaded · no manifest"} />
        <Stat href={`/${tenant.id}/restatements`} label="Restatements" value={count(o.restatements)} note="numbers that moved" border />
        <Stat href={`/${tenant.id}/holds`} label="Holds" value={count(o.holds)} note="rows held, not guessed" border="md" />
        <Stat href={`/${tenant.id}/revenue`} label="Incomplete" value={count(o.incompleteDays)} bad={o.incompleteDays > 0} note="revenue days missing a batch" border />
      </div>

      <div className="my-[30px] h-px bg-hairline" />

      <Eyebrow>deliveries · {o.matrix.length} sources × {new Set(o.matrix.flatMap((r) => r.cells.map((c) => c.batch))).size} batches{o.expected ? "" : " · no manifest"}</Eyebrow>
      <MiniMatrix matrix={o.matrix} tenantId={tenant.id} />
    </Panel>
  );
}

function Stat({ href, label, value, note, bad, border }: { href: string; label: string; value: string; note: string; bad?: boolean; border?: boolean | "md" }) {
  return (
    <Link href={href} className={cn("block", border === true && "border-l border-hairline pl-[18px]", border === "md" && "md:border-l md:border-hairline md:pl-[18px]")}>
      <Eyebrow className="block">{label}</Eyebrow>
      <Num className={cn("mt-3 block text-[23px] font-medium tracking-[-0.025em]", bad ? "text-st-bad" : "text-ink")} mono={false}>{value}</Num>
      <span className="mt-2 block text-[12.5px] leading-[1.4] text-ink-muted">{note}</span>
    </Link>
  );
}

/** One bar per expected batch, 14px tall; the missing one is the only red thing on the page. */
export function MiniMatrix({ matrix, tenantId }: { matrix: MatrixRow[]; tenantId: string }) {
  const batches = [...new Set(matrix.flatMap((r) => r.cells.map((c) => c.batch)))].sort((a, b) => a - b);
  return (
    <div className="mt-[14px] grid items-center gap-x-2 gap-y-[10px]" style={{ gridTemplateColumns: `112px repeat(${Math.max(batches.length, 1)}, minmax(0, 1fr))` }}>
      {matrix.map((row) => (
        <MatrixLine key={row.source} row={row} batches={batches} tenantId={tenantId} />
      ))}
    </div>
  );
}

function MatrixLine({ row, batches, tenantId }: { row: MatrixRow; batches: number[]; tenantId: string }) {
  return (
    <>
      <span className="whitespace-nowrap font-mono text-[12px] text-ink-muted">{row.source}</span>
      {batches.map((b) => {
        const c = row.cells.find((x) => x.batch === b);
        if (!c) return <span key={b} className="block h-[14px] rounded-[3px] border border-dashed border-hairline" />;
        return (
          <Link key={b} href={`/${tenantId}/deliveries`} title={`${row.source} batch ${c.batch}: ${c.status}${c.expected ? "" : " (not in the manifest)"}`}
            className={cn("block h-[14px] rounded-[3px]", c.status === "missing" ? "bg-st-bad" : c.status === "loaded" ? "bg-fill" : "bg-st-warn")} />
        );
      })}
    </>
  );
}

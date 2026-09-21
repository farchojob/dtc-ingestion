import type { RevenueTable } from "@/lib/queries";
import { count, money, symbol } from "@/lib/format";
import { cn } from "cn";
import { StateWord } from "../atoms";
import { SectionHead, Tbl, Tbody, Td, Tfoot, Th, Thead, Tr } from "../table";
import { TableCell, TableHead } from "@/components/ui/table";

/** Money cell: zero reads quieter than a number; negative in parentheses and red. */
function Money({ v, strong, dash }: { v: string | number; strong?: boolean; dash?: boolean }) {
  const n = Number(v);
  if (n === 0) return <span className="text-ink-muted">{dash ? "—" : "0.00"}</span>;
  return <span className={cn(n < 0 ? "text-st-bad" : strong ? "text-ink" : "text-ink-2")}>{money(n)}</span>;
}

export function RevenueView({ t }: { t: RevenueTable }) {
  const sym = symbol(t.currency);
  const chCols = t.channels.map(() => 112);
  return (
    <>
      <SectionHead title="Daily revenue" meta={`${t.rows.length} days · totals reconcile to the tenant card`} />
      <div className="mt-[18px]">
        <Tbl cols={[124, 84, 116, 110, 122, ...chCols, null]}>
          <Thead>
            <Tr className="hover:bg-transparent">
              <TableHead colSpan={5} className="h-auto border-b border-hairline p-0" />
              <TableHead colSpan={t.channels.length} className="h-auto border-b border-l border-hairline px-[18px] pb-[6px] pt-3 text-left font-normal">
                <span className="eyebrow">net by channel · {sym}</span>
              </TableHead>
              <TableHead className="h-auto border-b border-l border-hairline p-0" />
            </Tr>
            <Tr>
              <Th>Day</Th><Th align="right">Orders</Th><Th align="right">Gross {sym}</Th><Th align="right">Refunds {sym}</Th><Th align="right">Net {sym}</Th>
              {t.channels.map((c, i) => <Th key={c} align="right" className={cn(i === 0 && "border-l border-hairline")}>{c}</Th>)}
              <Th className="border-l border-hairline">Complete</Th>
            </Tr>
          </Thead>
          <Tbody>
            {t.rows.map((r) => (
              <Tr key={r.day} className="hover:bg-row-hover">
                <Td mono className="text-[13.5px] text-ink">{r.day}</Td>
                <Td mono align="right" muted>{r.orders}</Td>
                <Td mono align="right"><Money v={r.gross} /></Td>
                <Td mono align="right"><Money v={r.refunds} dash /></Td>
                <Td mono align="right" className="text-[13.5px]"><Money v={r.net} strong /></Td>
                {t.channels.map((c, i) => (
                  <Td key={c} mono align="right" className={cn(i === 0 && "border-l border-hairline")}><Money v={r.by_channel[c] ?? 0} /></Td>
                ))}
                <Td className="border-l border-hairline"><StateWord state={r.complete ? "yes" : "no"} tone={r.complete ? "neutral" : "bad"} /></Td>
              </Tr>
            ))}
          </Tbody>
          <Tfoot className="bg-row-hover font-medium">
            <Tr className="hover:bg-row-hover">
              <TableCell className="px-[18px] py-[14px] text-[13px] text-ink">{t.rows.length} days</TableCell>
              <TableCell className="num px-[18px] py-[14px] text-right font-mono text-[13px] text-ink">{count(t.totals.orders)}</TableCell>
              <TableCell className="num px-[18px] py-[14px] text-right font-mono text-[13px] text-ink">{money(t.totals.gross)}</TableCell>
              <TableCell className="num px-[18px] py-[14px] text-right font-mono text-[13px] text-ink">{money(t.totals.refunds)}</TableCell>
              <TableCell className="num px-[18px] py-[14px] text-right font-mono text-[13px] text-ink">{money(t.totals.net)}</TableCell>
              {t.channels.map((c, i) => (
                <TableCell key={c} className={cn("num px-[18px] py-[14px] text-right font-mono text-[13px] text-ink", i === 0 && "border-l border-hairline")}>{money(t.totals.by_channel[c] ?? 0)}</TableCell>
              ))}
              <TableCell className="border-l border-hairline" />
            </Tr>
          </Tfoot>
        </Tbl>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13.5px] text-ink-2">
        <StateWord state="complete = yes" tone="neutral" />
        <StateWord state="no" tone="bad" />
        <span className="text-ink-muted">a batch covering this day never arrived, so the row is partial</span>
      </div>
      <p className="mt-3 max-w-[900px] text-[13.5px] leading-[1.55] text-ink-muted">
        Negative values are shown in parentheses, the same rule as Restatements. <span className="font-mono">unattributed</span> is refunds whose order the pipeline could not find on the day of the refund.
      </p>
    </>
  );
}

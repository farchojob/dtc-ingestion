import type { RunRow } from "@/lib/queries";
import { count, stamp } from "@/lib/format";
import { cn } from "cn";
import { Num, StateWord } from "../atoms";
import { Tbl, Tbody, Td, Th, Thead, Tr } from "../table";
import { TableCell } from "@/components/ui/table";

/** Each run is a two-row unit: the numbers, then one full-width line saying what happened. */
export function RunsView({ rows, tenantName }: { rows: RunRow[]; tenantName: string }) {
  if (rows.length === 0) return null;
  return (
    <>
      <Tbl cols={[90, 170, 200, 92, 132, 152, 152, 112, null]}>
        <Thead><Tr>
          <Th>#</Th><Th>Status</Th><Th>Started</Th><Th align="right">Files</Th><Th align="right">Duplicates</Th><Th align="right">Rows inserted</Th>
          <Th align="right">Restatements</Th><Th align="right">Missing</Th><Th align="right">Args</Th>
        </Tr></Thead>
        <Tbody>
          {rows.map((r) => {
            const top = "border-b-0 px-[18px] pb-[6px] pt-5";
            return [
              <Tr key={r.id} className="hover:bg-transparent">
                <Td className={cn(top, "font-mono text-[17px] font-medium text-ink")}><Num>#{r.id}</Num></Td>
                <Td className={top}><StateWord state={r.status} /></Td>
                <Td mono muted className={top}>{stamp(r.started_at)}</Td>
                <Td mono align="right" className={top}>{r.files}</Td>
                <Td mono align="right" className={top}>{r.duplicates}</Td>
                <Td mono align="right" strong className={cn(top, "font-mono text-[13.5px]")}>{count(r.inserted)}</Td>
                <Td mono align="right" className={cn(top, r.restatements ? "text-ink" : "text-ink-muted")}>{r.restatements}</Td>
                <Td mono align="right" className={cn(top, r.missing ? "text-st-bad" : "text-ink-muted")}>{r.missing}</Td>
                <Td mono align="right" muted className={top}>{r.args || "—"}</Td>
              </Tr>,
              <Tr key={`${r.id}-context`} className="hover:bg-transparent">
                <TableCell colSpan={9} className="border-b border-hairline px-[18px] pb-5 pt-0 align-top">
                  <span className={cn("block whitespace-normal pl-0 font-mono text-[13px] leading-[1.5] md:pl-[90px]", r.status === "failed" ? "text-st-bad" : "text-ink-muted")}>
                    {r.context ?? "nothing to report: every file was new and every day complete"}
                  </span>
                </TableCell>
              </Tr>,
            ];
          })}
        </Tbody>
      </Tbl>
      <p className="mt-5 text-[14.5px] text-ink-muted">Runs are numbered across the whole pipeline; {tenantName}&apos;s numbers are not consecutive when another tenant ran in between.</p>
    </>
  );
}
